"""The worker of the ingestion.

The worker takes a job from the queue, reads the file from the object store,
loads the applicants into the database and starts the matching of the batch.
The upload request never does this work, which is what keeps the upload fast
and lets several files be processed one after the other.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any

from app.config import Settings, get_settings
from app.db.session import Database, get_database
from app.ingestion.csv_parser import parse_csv
from app.ingestion.queue import (
    IngestionJob,
    IngestionQueue,
    LocalIngestionQueue,
    get_queue,
    new_worker_id,
)
from app.ingestion.store import (
    complete_batch,
    complete_upload,
    create_batch,
    record_row_errors,
    store_rows,
)
from app.ingestion.storage import ObjectStore, get_object_store
from app.matching.dispatch import MatchingDispatcher

logger = logging.getLogger(__name__)


class IngestionWorker:
    """Processes the files of the queue."""

    def __init__(
        self,
        queue: IngestionQueue | None = None,
        store: ObjectStore | None = None,
        database: Database | None = None,
        settings: Settings | None = None,
        dispatcher: MatchingDispatcher | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.queue = queue or get_queue(self.settings)
        self.store = store or get_object_store(self.settings)
        self.database = database or get_database()
        self.worker_id = new_worker_id()
        self.dispatcher = dispatcher or MatchingDispatcher(
            database=self.database, settings=self.settings, worker_id=self.worker_id
        )

    # -- the job ------------------------------------------------------------

    def process(self, job: IngestionJob) -> bool:
        """Process one job.

        :param job: the job to process
        :return: True when the job was done
        """
        object_key = job.object_key or job.payload.get("object_key")
        if not object_key:
            self.queue.fail(job, "the job does not name an object")
            return False

        logger.info("processing upload %s (%s)", job.upload_id, object_key)
        try:
            summary = self._ingest(job, object_key)
        except Exception as error:  # noqa: BLE001 - the queue has to survive
            logger.exception("the upload %s failed", job.upload_id)
            self._mark_failed(job, str(error))
            self.queue.fail(job, str(error))
            return False

        self.queue.complete(job)
        logger.info(
            "upload %s done: %s",
            job.upload_id,
            json.dumps(summary, default=str),
        )
        batch_ids = summary.get("batch_ids") or []
        for batch_id in batch_ids:
            # The batch is only recorded here.  The dispatcher hands it over
            # to the workflow, at most a few batches at the same time, and
            # remembers a handover that did not work.
            self._queue_matching(batch_id)
        return True

    def _ingest(self, job: IngestionJob, object_key: str) -> dict[str, Any]:
        """Read the file, load the applicants and close the batches.

        The applicants are split into batches of a few thousand rows.  A
        workflow run has to stay small, because the Code node of n8n only
        gets a few seconds before the engine hands the next task on.  Every
        batch is matched on its own, so a file of any size is processed the
        same way.
        """
        settings = self.settings.ingestion
        with self.store.open(object_key) as stream:
            # The file is copied to a temporary file, the parser reads it from
            # there in chunks.
            temporary = Path(settings.local_storage_root) / "tmp" / f"{uuid.uuid4().hex}.csv"
            temporary.parent.mkdir(parents=True, exist_ok=True)
            try:
                with temporary.open("wb") as handle:
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        handle.write(chunk)
                result = parse_csv(temporary, max_rows=settings.csv_max_rows)
            finally:
                temporary.unlink(missing_ok=True)

        chunk_size = max(settings.chunk_rows, 100)
        chunks = [
            result.rows[index : index + chunk_size]
            for index in range(0, len(result.rows), chunk_size)
        ] or [[]]

        upload_id = job.payload.get("upload_id")
        batch_ids = []
        written = 0
        for chunk in chunks:
            batch_id = create_batch(
                self.database,
                filename=job.filename or "upload.csv",
                object_key=object_key,
                upload_id=upload_id,
            )
            written += store_rows(batch_id, chunk, self.database)
            complete_batch(
                batch_id,
                total_rows=len(chunk),
                accepted_rows=len(chunk),
                rejected_rows=0,
                unique_emails=0,
                database=self.database,
            )
            batch_ids.append(batch_id)

        # The rows that could not be used belong to the first batch, so they
        # are not lost.
        if result.errors:
            record_row_errors(batch_ids[0], result.errors, self.database)
            self.database.execute(
                "UPDATE ingestion_batches SET rejected_rows = %s WHERE batch_id = %s",
                (len(result.errors), batch_ids[0]),
            )

        if upload_id:
            complete_upload(
                upload_id,
                status="completed",
                total_rows=result.total_rows,
                accepted_rows=written,
                rejected_rows=len(result.errors),
                database=self.database,
            )

        return {
            "rows": result.total_rows,
            "accepted": written,
            "rejected": len(result.errors),
            "batches": len(batch_ids),
            "batch_ids": batch_ids,
        }

    def _mark_failed(self, job: IngestionJob, error: str) -> None:
        """Mark the upload of a failed job as failed."""
        try:
            self.database.execute(
                """
                UPDATE ingestion_uploads
                SET status = 'failed', error = %s, completed_at = NOW()
                WHERE upload_id = %s
                """,
                (error[:2000], job.upload_id),
            )
        except Exception:  # noqa: BLE001 - the database may be the problem
            logger.exception("the upload %s could not be marked as failed", job.upload_id)

    def _queue_matching(self, batch_id: str) -> None:
        """Record that the batch has to be matched.

        The handover itself is done by the dispatcher, which limits how many
        batches run at the same time and retries a handover that failed.
        """
        if not self.settings.ingestion.trigger_matching:
            return
        try:
            self.dispatcher.enqueue(batch_id)
            logger.info("the matching of %s was queued", batch_id)
        except Exception:  # noqa: BLE001 - the applicants are already stored
            logger.exception("the matching of %s could not be queued", batch_id)

    # -- the loop ------------------------------------------------------------

    def run_forever(self, poll_seconds: float = 2.0) -> None:
        """Process jobs until the worker is stopped."""
        logger.info("worker %s is waiting for work", self.worker_id)
        self.dispatcher.recover()
        while True:
            job = self.queue.claim(self.worker_id)
            if job is None:
                self._dispatch_cycle()
                time.sleep(poll_seconds)
                continue
            self.process(job)
            self._dispatch_cycle()

    def _dispatch_cycle(self) -> None:
        """Run one round of the dispatcher, without letting it break the worker."""
        try:
            self.dispatcher.run_cycle()
        except Exception:  # noqa: BLE001 - the queue has to survive
            logger.exception("the dispatch of the matching failed")


def main() -> int:
    """Run a worker until it is interrupted."""
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    worker = IngestionWorker()
    try:
        worker.run_forever()
    except KeyboardInterrupt:
        logger.info("the worker is stopping")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
