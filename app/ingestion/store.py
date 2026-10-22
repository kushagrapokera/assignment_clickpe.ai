"""Writing the ingested applicants into the database.

The upload service and the tests use the same functions, so the way a batch
reaches the database is defined in exactly one place.
"""

from __future__ import annotations

import logging
import json
import uuid
from typing import Any, Iterable

from app.db.session import Database, get_database
from app.ingestion.csv_parser import RowError, ELIGIBILITY_FACT_FIELDS

logger = logging.getLogger(__name__)

# How many rows are written with one statement.
CHUNK_SIZE = 1000

UPSERT_USER = """
INSERT INTO users (user_id, name, email, monthly_income, annual_income,
                   credit_score, employment_status, age, city, existing_emi,
                   batch_id, eligibility_facts)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (user_id) DO UPDATE SET
    name = EXCLUDED.name,
    email = EXCLUDED.email,
    monthly_income = EXCLUDED.monthly_income,
    annual_income = EXCLUDED.annual_income,
    credit_score = EXCLUDED.credit_score,
    employment_status = EXCLUDED.employment_status,
    age = EXCLUDED.age,
    city = EXCLUDED.city,
    existing_emi = EXCLUDED.existing_emi,
    batch_id = EXCLUDED.batch_id,
    eligibility_facts = EXCLUDED.eligibility_facts,
    updated_at = NOW()
"""


def create_upload(
    database: Database | None = None,
    filename: str = "upload.csv",
    object_key: str | None = None,
    size_bytes: int | None = None,
    chunk_size: int = 1000,
    upload_id: uuid.UUID | str | None = None,
) -> str:
    """Register an uploaded file and return its id.

    :param database: the database to use
    :param filename: name of the uploaded file
    :param object_key: where the file is stored
    :param size_bytes: the size of the file
    :param chunk_size: how many rows one batch holds
    :param upload_id: use a fixed id instead of a new one
    :return: the upload id
    """
    db = database or get_database()
    identifier = str(upload_id or uuid.uuid4())
    db.execute(
        """
        INSERT INTO ingestion_uploads
            (upload_id, filename, object_key, size_bytes, chunk_size, status)
        VALUES (%s, %s, %s, %s, %s, 'queued')
        ON CONFLICT (upload_id) DO UPDATE SET
            filename = EXCLUDED.filename,
            object_key = EXCLUDED.object_key,
            size_bytes = EXCLUDED.size_bytes,
            chunk_size = EXCLUDED.chunk_size,
            status = 'queued'
        """,
        (identifier, filename, object_key, size_bytes, chunk_size),
    )
    return identifier


def complete_upload(
    upload_id: str,
    status: str = 'completed',
    total_rows: int = 0,
    accepted_rows: int = 0,
    rejected_rows: int = 0,
    error: str | None = None,
    database: Database | None = None,
) -> None:
    """Mark an upload as processed.

    :param upload_id: the upload that was processed
    :param status: the state of the upload
    :param total_rows: the number of rows in the file
    :param accepted_rows: the number of rows that were used
    :param rejected_rows: the number of rows that were rejected
    :param error: what went wrong
    :param database: the database to use
    """
    db = database or get_database()
    db.execute(
        """
        UPDATE ingestion_uploads
        SET status = %s, total_rows = %s, accepted_rows = %s, rejected_rows = %s,
            error = %s, completed_at = NOW()
        WHERE upload_id = %s
        """,
        (status, total_rows, accepted_rows, rejected_rows, error, upload_id),
    )


def create_batch(
    database: Database | None = None,
    filename: str = "upload.csv",
    object_key: str | None = None,
    batch_id: uuid.UUID | str | None = None,
    upload_id: str | None = None,
) -> str:
    """Create an ingestion batch and return its id.

    :param database: the database to use
    :param filename: name of the uploaded file
    :param object_key: where the file is stored
    :param batch_id: use a fixed batch id instead of a new one
    :param upload_id: the upload the batch belongs to
    :return: the batch id
    """
    db = database or get_database()
    identifier = str(batch_id or uuid.uuid4())
    db.execute(
        """
        INSERT INTO ingestion_batches (batch_id, filename, object_key, status, upload_id, storage_mode)
        VALUES (%s, %s, %s, 'processing', %s, 'optimised')
        ON CONFLICT (batch_id) DO UPDATE SET
            filename = EXCLUDED.filename,
            object_key = EXCLUDED.object_key,
            status = 'processing',
            upload_id = EXCLUDED.upload_id,
            storage_mode = 'optimised'
        """,
        (identifier, filename, object_key, upload_id),
    )
    return identifier


def store_rows(
    batch_id: str,
    rows: Iterable[dict[str, Any]],
    database: Database | None = None,
    chunk_size: int = CHUNK_SIZE,
) -> int:
    """Write the applicants of a batch into the database.

    :param batch_id: the batch the rows belong to
    :param rows: the validated rows
    :param database: the database to use
    :param chunk_size: rows per statement
    :return: the number of rows written
    """
    db = database or get_database()
    written = 0
    chunk: list[dict[str, Any]] = []

    for row in rows:
        chunk.append(row)
        if len(chunk) >= chunk_size:
            written += _write_chunk(db, batch_id, chunk)
            chunk = []
    if chunk:
        written += _write_chunk(db, batch_id, chunk)
    return written


def _write_chunk(
    database: Database, batch_id: str, chunk: list[dict[str, Any]]
) -> int:
    """Write one chunk of rows."""
    values = [
        (
            row["user_id"],
            row.get("name"),
            row["email"],
            row.get("monthly_income"),
            row.get("annual_income"),
            row.get("credit_score"),
            row.get("employment_status"),
            row.get("age"),
            row.get("city"),
            row.get("existing_emi"),
            batch_id,
            json.dumps({field: row[field] for field in ELIGIBILITY_FACT_FIELDS if field in row}),
        )
        for row in chunk
    ]
    with database.transaction() as connection:
        with connection.cursor() as cursor:
            cursor.executemany(UPSERT_USER, values)
    return len(values)


def record_row_errors(
    batch_id: str,
    errors: Iterable[RowError],
    database: Database | None = None,
) -> int:
    """Store the rows that could not be used.

    :param batch_id: the batch the rows belong to
    :param errors: the rejected rows
    :param database: the database to use
    :return: the number of rows stored
    """
    db = database or get_database()
    errors = list(errors)
    if not errors:
        return 0
    with db.transaction() as connection:
        with connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO ingestion_row_errors (batch_id, row_number, raw_row, message)
                VALUES (%s, %s, %s, %s)
                """,
                [
                    (
                        batch_id,
                        error.row_number,
                        _as_json(error.raw),
                        error.message,
                    )
                    for error in errors
                ],
            )
    return len(errors)


def complete_batch(
    batch_id: str,
    total_rows: int,
    accepted_rows: int,
    rejected_rows: int,
    unique_emails: int = 0,
    database: Database | None = None,
) -> None:
    """Mark a batch as processed.

    :param batch_id: the batch that was processed
    :param total_rows: the number of rows in the file
    :param accepted_rows: the number of rows that were used
    :param rejected_rows: the number of rows that were rejected
    :param unique_emails: the number of distinct email addresses
    :param database: the database to use
    """
    db = database or get_database()
    db.execute(
        """
        UPDATE ingestion_batches
        SET status = 'completed',
            total_rows = %s,
            accepted_rows = %s,
            rejected_rows = %s,
            unique_emails = %s,
            completed_at = NOW()
        WHERE batch_id = %s
        """,
        (total_rows, accepted_rows, rejected_rows, unique_emails, batch_id),
    )


def _as_json(value: Any) -> str:
    """Return a value as a JSON string."""
    import json

    return json.dumps(value, default=str)
