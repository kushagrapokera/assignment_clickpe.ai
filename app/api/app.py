"""The HTTP interface of the engine.

The service offers the upload page and a small API around it:

* ``POST /api/uploads``         upload an applicant file, it is stored and queued
* ``GET  /api/batches``          the list of the batches
* ``GET  /api/batches/{id}``     the state of one batch, with its matches
* ``GET  /api/matches/{id}``     the matches of a batch
* ``GET  /api/products``         the catalogue that was discovered
* ``GET  /api/health``           a health check

The upload only stores the file and hands the work over to the queue, it does
not parse anything, so the request returns as soon as the file is on disk.
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.db.session import Database
from app.ingestion.queue import get_queue
from app.ingestion.storage import get_object_store
from app.ingestion.store import create_upload
from app.api.qualitative import router as qualitative_router
from app.api.decisions import router as decisions_router

logger = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

app = FastAPI(
    title="Loan Eligibility Engine",
    description=(
        "Ingests applicant files, discovers personal loan products and matches "
        "the applicants against them."
    ),
    version="1.0.0",
)
app.include_router(qualitative_router)
app.include_router(decisions_router)


def _database():
    """Return a database helper."""
    # Requests run concurrently; one request must not close another's connection.
    return Database()


@app.get("/api/health")
def health() -> dict[str, Any]:
    """A health check of the service and of the database."""
    database = _database()
    try:
        products = database.fetch_value("SELECT count(*) FROM loan_products WHERE active")
        return {"status": "ok", "products": int(products or 0)}
    finally:
        database.close()


@app.post("/api/uploads")
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    """Store an applicant file and queue the work.

    The file is streamed into the object store, the batch is created and the
    job is put on the queue.  The parsing happens in the worker, so this
    request stays fast even for a large file.
    """
    settings = get_settings()
    filename = Path(file.filename or "upload.csv").name
    if not filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="the file has to be a csv")

    upload_id = str(uuid.uuid4())
    object_key = f"uploads/{upload_id}/{filename}"
    store = get_object_store(settings)
    queue = get_queue(settings)

    database = _database()
    try:
        create_upload(
            database,
            filename=filename,
            object_key=object_key,
            chunk_size=settings.ingestion.chunk_rows,
            upload_id=upload_id,
        )
        try:
            size = store.put(
                object_key,
                file.file,
                max_bytes=settings.ingestion.csv_max_bytes,
            )
        except ValueError as error:
            database.execute(
                "UPDATE ingestion_uploads SET status = 'rejected', error = %s WHERE upload_id = %s",
                (str(error), upload_id),
            )
            raise HTTPException(status_code=413, detail=str(error)) from error

        database.execute(
            "UPDATE ingestion_uploads SET size_bytes = %s WHERE upload_id = %s",
            (size, upload_id),
        )
        queue.enqueue(
            upload_id,
            {
                "upload_id": upload_id,
                "object_key": object_key,
                "filename": filename,
                "size": size,
            },
        )
    finally:
        database.close()

    logger.info("upload %s accepted (%s, %s bytes)", upload_id, filename, size)
    return JSONResponse(
        {
            "upload_id": upload_id,
            "filename": filename,
            "size": size,
            "status": "queued",
            "links": {"self": f"/api/uploads/{upload_id}"},
        },
        status_code=202,
    )


@app.get("/api/uploads")
def list_uploads(limit: int = 25) -> dict[str, Any]:
    """The most recent uploads."""
    database = _database()
    try:
        rows = database.fetch_all(
            """
            SELECT u.upload_id, u.filename, u.status, u.total_rows, u.accepted_rows,
                   u.rejected_rows, u.chunk_size, u.created_at, u.completed_at,
                   (SELECT count(*) FROM ingestion_batches b WHERE b.upload_id = u.upload_id) AS batches,
                   (SELECT count(*) FROM matches m JOIN ingestion_batches b
                     ON b.batch_id = m.batch_id WHERE b.upload_id = u.upload_id) AS matches
            FROM ingestion_uploads u
            ORDER BY u.created_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        return {"uploads": rows}
    finally:
        database.close()


@app.get("/api/uploads/{upload_id}")
def get_upload(upload_id: str, summary_only: bool = False) -> dict[str, Any]:
    """The state of one upload, with its batches and their results."""
    database = _database()
    try:
        upload = database.fetch_one(
            "SELECT * FROM ingestion_uploads WHERE upload_id = %s", (upload_id,)
        )
        if not upload:
            raise HTTPException(status_code=404, detail="unknown upload")
        if summary_only:
            batches = database.fetch_all("""
                SELECT b.batch_id,b.status,b.total_rows,b.accepted_rows,b.rejected_rows,
                  b.matching_status,b.matching_started_at,b.fast_completed_at,
                  b.matching_completed_at,b.matching_pending_pairs,b.notifications_completed_at,
                  (SELECT count(*) FROM matches m WHERE m.batch_id=b.batch_id) AS matches,
                  (SELECT count(*) FROM notifications n JOIN users u USING(user_id)
                    WHERE u.batch_id=b.batch_id) AS notifications,
                  (SELECT count(*) FROM notifications n JOIN users u USING(user_id)
                    WHERE u.batch_id=b.batch_id AND n.status='sent') AS notifications_sent,
                  (SELECT count(*) FROM notifications n JOIN users u USING(user_id)
                    WHERE u.batch_id=b.batch_id AND n.status='failed') AS notifications_failed,
                  d.status AS dispatch_status,d.last_error AS dispatch_error
                FROM ingestion_batches b LEFT JOIN matching_dispatches d USING(batch_id)
                WHERE b.upload_id=%s ORDER BY b.created_at
            """, (upload_id,))
            finished = bool(batches) and all(b['matching_status'] == 'completed'
                and b['notifications_completed_at'] for b in batches)
            counts = None
            if finished:
                rows = database.fetch_all("""
                    SELECT lane,count(*) AS decisions FROM ui_decisions
                    WHERE batch_id=ANY(%s::uuid[]) GROUP BY lane
                """, ([str(b['batch_id']) for b in batches],))
                counts = {'rules': 0, 'qualitative': 0}
                counts.update({r['lane']: r['decisions'] for r in rows})
            return {"upload": upload, "batches": batches, "decision_counts": counts}
        batches = database.fetch_all(
            """
            SELECT b.batch_id, b.status, b.total_rows, b.accepted_rows, b.rejected_rows,
                   b.matching_status, b.matching_started_at, b.fast_completed_at,
                   b.matching_completed_at, b.matching_pending_pairs, b.notifications_completed_at,
                   COALESCE((SELECT jsonb_object_agg(lane, stats) FROM (
                     SELECT d.applicant_lane AS lane, jsonb_build_object(
                       'applicants',count(DISTINCT d.user_id),'total',count(*),
                       'eligible',count(*) FILTER (WHERE d.status='eligible'),
                       'ineligible',count(*) FILTER (WHERE d.status='ineligible'),
                       'review',count(*) FILTER (WHERE d.status='review'),
                       'pending',count(*) FILTER (WHERE d.status='pending'),
                       'recorded',bool_and(d.recorded)) AS stats
                     FROM (
                       SELECT decisions.*,
                         CASE WHEN bool_or(lane='qualitative') OVER (PARTITION BY user_id)
                           THEN 'qualitative' ELSE 'rules' END AS applicant_lane
                       FROM ui_decisions decisions WHERE batch_id=b.batch_id
                     ) d GROUP BY d.applicant_lane
                   ) lanes), '{}'::jsonb) AS lanes,
                    (SELECT count(*) FROM matches m WHERE m.batch_id = b.batch_id) AS matches,
                    (SELECT count(*) FROM notifications n JOIN users u ON u.user_id = n.user_id
                      WHERE u.batch_id = b.batch_id) AS notifications,
                    (SELECT count(*) FROM notifications n JOIN users u ON u.user_id = n.user_id
                      WHERE u.batch_id = b.batch_id AND n.status = 'sent') AS notifications_sent,
                    (SELECT count(*) FROM notifications n JOIN users u ON u.user_id = n.user_id
                      WHERE u.batch_id = b.batch_id AND n.status = 'failed') AS notifications_failed,
                    (SELECT d.status FROM matching_dispatches d
                      WHERE d.batch_id = b.batch_id LIMIT 1) AS dispatch_status,
                    (SELECT d.attempts FROM matching_dispatches d
                      WHERE d.batch_id = b.batch_id LIMIT 1) AS dispatch_attempts,
                    (SELECT d.last_error FROM matching_dispatches d
                      WHERE d.batch_id = b.batch_id LIMIT 1) AS dispatch_error,
                    b.storage_mode
            FROM ingestion_batches b
            WHERE b.upload_id = %s
            ORDER BY b.created_at
            """,
            (upload_id,),
        )
        return {"upload": upload, "batches": batches}
    finally:
        database.close()


@app.get("/api/batches")
def list_batches(limit: int = 25) -> dict[str, Any]:
    """The most recent batches."""
    database = _database()
    try:
        rows = database.fetch_all(
            """
            SELECT b.batch_id, b.filename, b.status, b.total_rows, b.accepted_rows,
                   b.rejected_rows, b.created_at, b.completed_at,
                   (SELECT count(*) FROM matches m WHERE m.batch_id = b.batch_id) AS matches,
                   (SELECT count(*) FROM notifications n
                     JOIN users u ON u.user_id = n.user_id
                    WHERE u.batch_id = b.batch_id) AS notifications
            FROM ingestion_batches b
            ORDER BY b.created_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        return {"batches": rows}
    finally:
        database.close()


@app.get("/api/batches/{batch_id}")
def get_batch(batch_id: str) -> dict[str, Any]:
    """The state of one batch, including its matches and notifications."""
    database = _database()
    try:
        batch = database.fetch_one(
            "SELECT * FROM ingestion_batches WHERE batch_id = %s", (batch_id,)
        )
        if not batch:
            raise HTTPException(status_code=404, detail="unknown batch")
        errors = database.fetch_all(
            """
            SELECT row_number, message FROM ingestion_row_errors
            WHERE batch_id = %s ORDER BY row_number LIMIT 50
            """,
            (batch_id,),
        )
        matches = database.fetch_all(
            """
            SELECT u.name, u.email, u.employment_status, u.monthly_income, u.credit_score,
                   u.age, p.provider, p.product_name, m.status, m.decided_by,
                   p.interest_rate_min, p.interest_rate_max, p.max_loan_amount,
                   p.min_tenure_months, p.max_tenure_months
            FROM matches m
            JOIN users u ON u.user_id = m.user_id
            JOIN loan_products p ON p.product_id = m.product_id
            WHERE m.batch_id = %s
            ORDER BY u.name, p.interest_rate_min NULLS LAST
            """,
            (batch_id,),
        )
        notifications = database.fetch_all(
            """
            SELECT n.recipient, n.status, n.match_count, n.review_count, n.created_at, n.error
            FROM notifications n
            JOIN users u ON u.user_id = n.user_id
            WHERE u.batch_id = %s
            ORDER BY n.notification_id DESC
            """,
            (batch_id,),
        )
        dispatch = database.fetch_one(
            """
            SELECT d.status, d.attempts, d.last_error, d.dispatched_at, d.completed_at
            FROM matching_dispatches d WHERE d.batch_id = %s LIMIT 1
            """,
            (batch_id,),
        )
        run = database.fetch_one(
            """
            SELECT applicants, products, candidate_pairs, evaluated_pairs, decisions_written,
                   matches_written, external_updates, payload_bytes, fetch_ms, rules_ms,
                   persist_ms, external_ms, notifications_ms, llm_requests, llm_verdicts,
                   started_at, completed_at
            FROM matching_runs WHERE batch_id = %s ORDER BY started_at DESC LIMIT 1
            """,
            (batch_id,),
        )
        return {
            "batch": batch,
            "row_errors": errors,
            "matches": matches,
            "notifications": notifications,
            "dispatch": dispatch,
            "run": run,
        }
    finally:
        database.close()


@app.get("/api/matches/{batch_id}")
def get_matches(batch_id: str, limit: int = 500) -> dict[str, Any]:
    """The matches of a batch."""
    database = _database()
    try:
        rows = database.fetch_all(
            """
            SELECT u.user_id, u.name, p.provider, p.product_name, m.status, m.decided_by,
                   p.interest_rate_min, p.interest_rate_max
            FROM matches m
            JOIN users u ON u.user_id = m.user_id
            JOIN loan_products p ON p.product_id = m.product_id
            WHERE m.batch_id = %s
            ORDER BY u.name, p.interest_rate_min NULLS LAST
            LIMIT %s
            """,
            (batch_id, limit),
        )
        return {"batch_id": batch_id, "matches": rows, "count": len(rows)}
    finally:
        database.close()


@app.get("/api/products")
def list_products(limit: int = 100) -> dict[str, Any]:
    """The catalogue of the discovered loan products."""
    database = _database()
    try:
        rows = database.fetch_all(
            """
            SELECT product_key, product_name, provider, interest_rate_min, interest_rate_max,
                   min_loan_amount, max_loan_amount, min_tenure_months, max_tenure_months,
                   min_monthly_income, min_credit_score, min_age, max_age,
                   required_employment_statuses, source_url, updated_at
            FROM loan_products
            WHERE active
            ORDER BY provider, product_name
            LIMIT %s
            """,
            (limit,),
        )
        return {"products": rows, "count": len(rows)}
    finally:
        database.close()


@app.get("/")
def index() -> FileResponse:
    """The upload page."""
    return FileResponse(FRONTEND_DIR / "index.html")


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
