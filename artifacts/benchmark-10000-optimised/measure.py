"""Measure the optimised pipeline on the same 10 000 record CSV.

The script uploads the benchmark file through the HTTP interface, follows the
run and writes what it measured to ``results.json``:

* the time until the first results are visible and until every batch is
  matched and notified,
* the duration of every stage of every matching run (``matching_runs``),
* the payload that travelled through the workflow and the rows that were
  written,
* the peak of concurrent matching batches.

Usage::

    python3 artifacts/benchmark-10000-optimised/measure.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.config import get_settings  # noqa: E402
from app.db.session import get_database  # noqa: E402

ROOT = Path(__file__).resolve().parent
CSV = ROOT.parent.parent / "samples" / "ui_benchmark_10000.csv"
API = "http://127.0.0.1:8000"


def upload(path: Path) -> dict:
    """Upload the benchmark file and return the answer of the service."""
    boundary = "----loanenginebenchmark"
    body = b""
    body += f"--{boundary}\r\n".encode()
    body += (
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        "Content-Type: text/csv\r\n\r\n"
    ).encode()
    body += path.read_bytes()
    body += f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        f"{API}/api/uploads",
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=120) as response:
        answer = json.load(response)
    return {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "upload_response_seconds": time.monotonic() - started,
        **answer,
    }


def main() -> int:
    settings = get_settings()
    database = get_database()
    existing = os.environ.get("BENCHMARK_UPLOAD_ID")
    if existing:
        request = {
            "started_at": datetime.now(timezone.utc).isoformat(),
            "upload_id": existing,
            "resumed": True,
        }
    else:
        request = upload(CSV)
    upload_id = request["upload_id"]
    (ROOT / "ui-upload.json").write_text(json.dumps(request, indent=2))
    print(f"uploaded {upload_id}", flush=True)

    history: list[dict] = []
    deadline = time.monotonic() + 2400
    while True:
        batches = database.fetch_all(
            """
            SELECT batch_id, total_rows, matching_status, matching_started_at,
                   fast_completed_at, matching_completed_at, matching_pending_pairs,
                   notifications_completed_at
            FROM ingestion_batches WHERE upload_id = %s ORDER BY created_at
            """,
            (upload_id,),
        )
        ids = [str(batch["batch_id"]) for batch in batches]
        decisions = database.fetch_one(
            """
            SELECT count(*) AS decisions,
                   count(*) FILTER (WHERE status = 'eligible') AS eligible,
                   count(*) FILTER (WHERE status = 'ineligible') AS ineligible,
                   count(*) FILTER (WHERE status = 'review') AS review
            FROM matching_decisions WHERE batch_id = ANY(%s::uuid[])
            """,
            (ids,),
        ) if ids else {}
        matches = database.fetch_value(
            "SELECT count(*) FROM matches WHERE batch_id = ANY(%s::uuid[])", (ids,)
        ) if ids else 0
        notifications = database.fetch_all(
            """
            SELECT n.status, count(*) AS count FROM notifications n
            JOIN users u ON u.user_id = n.user_id
            WHERE u.batch_id = ANY(%s::uuid[]) GROUP BY n.status
            """,
            (ids,),
        ) if ids else []
        first_results = next(
            (batch["fast_completed_at"] for batch in batches if batch["fast_completed_at"]),
            None,
        )
        point = {
            "at": datetime.now(timezone.utc).isoformat(),
            "batches": len(batches),
            "fast_batches": sum(1 for batch in batches if batch["fast_completed_at"]),
            "matching_completed": sum(
                1 for batch in batches if batch["matching_status"] == "completed"
            ),
            "notification_completed": sum(
                1 for batch in batches if batch["notifications_completed_at"]
            ),
            "decisions": decisions,
            "matches": matches,
            "notifications": notifications,
            "dispatch": database.fetch_one(
                "SELECT value FROM runtime_metrics WHERE metric = 'matching_dispatch'"
            ),
        }
        history.append(point)
        (ROOT / "history.json").write_text(json.dumps(history, indent=2, default=str))
        print(json.dumps(point, default=str), flush=True)

        finished = len(batches) == 20 and point["notification_completed"] == 20
        if finished or time.monotonic() > deadline:
            break
        time.sleep(5)

    runs = database.fetch_all(
        """
        SELECT started_at, completed_at, applicants, products, candidate_pairs,
               evaluated_pairs, decisions_written, matches_written, external_updates,
               payload_bytes, fetch_ms, rules_ms, persist_ms, external_ms,
               notifications_ms, llm_requests, llm_verdicts
        FROM matching_runs WHERE batch_id = ANY(%s::uuid[])
        ORDER BY started_at
        """,
        (ids,),
    )
    report = {
        "upload_request": request,
        "history": history,
        "runs": runs,
        "decisions": decisions,
        "matches": matches,
        "notifications": notifications,
        "measured_at": datetime.now(timezone.utc).isoformat(),
    }
    (ROOT / "results.json").write_text(json.dumps(report, indent=2, default=str))
    print("written", ROOT / "results.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
