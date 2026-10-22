"""The queue of the ingestion.

The upload request does not parse the file, it only hands the work over to a
worker.  The queue is the handover point, and it is shaped like the queue of
the deployment on AWS: a message with a body, a visibility timeout and a
number of attempts.  The local implementation uses a table with a lease, the
Amazon implementation sends the message to SQS.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.config import Settings, get_settings
from app.db.session import Database, get_database

logger = logging.getLogger(__name__)


@dataclass
class IngestionJob:
    """One unit of work of the ingestion."""

    queue_id: int
    upload_id: str
    payload: dict[str, Any] = field(default_factory=dict)
    attempts: int = 0
    object_key: str | None = None
    filename: str | None = None


class IngestionQueue(Protocol):
    """The interface every queue has to offer."""

    def enqueue(self, batch_id: str, payload: dict[str, Any]) -> int:
        """Put a job on the queue and return its id."""
        ...

    def claim(self, worker_id: str) -> IngestionJob | None:
        """Take the next job of the queue, or None when there is nothing."""
        ...

    def complete(self, job: IngestionJob) -> None:
        """Mark a job as done."""
        ...

    def fail(self, job: IngestionJob, error: str, retry_in: int = 30) -> None:
        """Mark a job as failed, either for a retry or as permanently broken."""
        ...


class LocalIngestionQueue:
    """A queue that lives in the database.

    The claim uses ``FOR UPDATE SKIP LOCKED``, so several workers can take
    jobs at the same time without working on the same one.
    """

    def __init__(self, database: Database | None = None) -> None:
        self.database = database or get_database()

    def enqueue(self, upload_id: str, payload: dict[str, Any]) -> int:
        """Put a job on the queue and return its id."""
        row = self.database.fetch_one(
            """
            INSERT INTO ingestion_queue (upload_id, payload, status)
            VALUES (%s, %s, 'pending')
            RETURNING queue_id
            """,
            (upload_id, json.dumps(payload, default=str)),
        )
        return int(row["queue_id"])

    def claim(self, worker_id: str) -> IngestionJob | None:
        """Take the next job of the queue, or None when there is nothing.

        A job that is taken is marked as running, so a second worker does not
        pick it up as well.  A job whose worker died is taken over again once
        its lease ran out.
        """
        lease = get_settings().ingestion.lease_seconds
        row = self.database.fetch_one(
            """
            WITH candidate AS (
                SELECT queue_id
                FROM ingestion_queue
                WHERE (status = 'pending' AND available_at <= NOW())
                   OR (status = 'running'
                       AND locked_at < NOW() - (%s || ' seconds')::interval)
                ORDER BY queue_id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE ingestion_queue q
            SET status = 'running',
                locked_at = NOW(),
                locked_by = %s,
                attempts = q.attempts + 1,
                updated_at = NOW()
            FROM candidate c
            WHERE q.queue_id = c.queue_id
            RETURNING q.queue_id, q.upload_id, q.payload, q.attempts
            """,
            (lease, worker_id),
        )
        if not row:
            return None
        payload = row["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        return IngestionJob(
            queue_id=int(row["queue_id"]),
            upload_id=str(row["upload_id"]),
            payload=payload or {},
            attempts=int(row["attempts"]),
            object_key=(payload or {}).get("object_key"),
            filename=(payload or {}).get("filename"),
        )

    def complete(self, job: IngestionJob) -> None:
        """Mark a job as done."""
        self.database.execute(
            """
            UPDATE ingestion_queue
            SET status = 'done', locked_at = NULL, locked_by = NULL, updated_at = NOW()
            WHERE queue_id = %s
            """,
            (job.queue_id,),
        )

    def fail(self, job: IngestionJob, error: str, retry_in: int = 30) -> None:
        """Mark a job as failed.

        A job that has run out of attempts is marked as failed for good, so
        it does not block the queue.
        """
        settings = get_settings()
        permanent = job.attempts >= settings.ingestion.max_attempts
        self.database.execute(
            """
            UPDATE ingestion_queue
            SET status = %s,
                last_error = %s,
                available_at = NOW() + (%s || ' seconds')::interval,
                locked_at = NULL,
                locked_by = NULL,
                updated_at = NOW()
            WHERE queue_id = %s
            """,
            ("failed" if permanent else "pending", error[:2000], retry_in, job.queue_id),
        )

    def pending_count(self) -> int:
        """Return the number of jobs that still have to be done."""
        row = self.database.fetch_one(
            "SELECT count(*) AS total FROM ingestion_queue WHERE status = 'pending'"
        )
        return int(row["total"]) if row else 0


class SqsIngestionQueue:
    """A queue that sends the work to Amazon SQS.

    The message carries the same payload as the local queue, so the worker
    does not have to know which queue it is reading.
    """

    def __init__(self, queue_url: str | None = None) -> None:
        import boto3

        settings = get_settings()
        self.queue_url = queue_url or settings.ingestion.sqs_queue_url
        self.client = boto3.client("sqs", region_name=settings.aws_region)

    def enqueue(self, upload_id: str, payload: dict[str, Any]) -> int:
        """Put a job on the queue."""
        response = self.client.send_message(
            QueueUrl=self.queue_url,
            MessageBody=json.dumps({"upload_id": upload_id, **payload}, default=str),
        )
        return int(response.get("MessageId", 0))

    def claim(self, worker_id: str) -> IngestionJob | None:
        """Take the next job of the queue."""
        response = self.client.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=1,
            VisibilityTimeout=get_settings().ingestion.lease_seconds,
            WaitTimeSeconds=5,
        )
        messages = response.get("Messages") or []
        if not messages:
            return None
        message = messages[0]
        body = json.loads(message["Body"])
        return IngestionJob(
            queue_id=int(message.get("MessageId", 0)),
            upload_id=str(body.get("upload_id")),
            payload=body,
            attempts=1,
            object_key=body.get("object_key"),
            filename=body.get("filename"),
        )

    def complete(self, job: IngestionJob) -> None:
        """Remove the message of a job from the queue."""
        self.client.delete_message(
            QueueUrl=self.queue_url, ReceiptHandle=str(job.payload.get("receipt_handle", ""))
        )

    def fail(self, job: IngestionJob, error: str, retry_in: int = 30) -> None:
        """Let the message come back after the visibility timeout."""
        logger.warning("the job %s failed: %s", job.batch_id, error)


def get_queue(settings: Settings | None = None) -> IngestionQueue:
    """Return the queue the configuration asks for."""
    resolved = settings or get_settings()
    if resolved.ingestion.storage == "s3":
        return SqsIngestionQueue()
    return LocalIngestionQueue()


def new_worker_id() -> str:
    """Return an id that identifies one worker."""
    import socket

    return f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"
