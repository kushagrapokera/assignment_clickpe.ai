"""The durable dispatch of the matching of a batch.

The ingestion worker does not call the matching workflow itself.  It records
the batch in the ``matching_dispatches`` table and a dispatcher hands the
batches over, one batch at a time and at most a few at the same time.

That has three consequences that matter:

* a failed handover is remembered, so the batch is tried again instead of
  being lost,
* a restart of the worker finds the unfinished dispatches and finishes them,
  without sending the same batch to the workflow twice,
* a slow batch does not stop the other batches: the number of batches that
  run at the same time is limited, the queue absorbs the rest.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from app.config import Settings, get_settings
from app.db.session import Database, get_database

logger = logging.getLogger(__name__)


@dataclass
class Dispatch:
    """One batch that has to be matched."""

    dispatch_id: int
    batch_id: str
    attempts: int = 0


class MatchingDispatcher:
    """Hands the batches over to the matching workflow."""

    def __init__(
        self,
        database: Database | None = None,
        settings: Settings | None = None,
        worker_id: str | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.database = database or get_database()
        self.worker_id = worker_id or f"dispatch-{os.getpid()}"
        self.peak = 0

    # -- the queue -----------------------------------------------------------

    def enqueue(self, batch_id: str) -> int:
        """Record that a batch has to be matched.

        The row is unique per batch, so asking twice for the same batch never
        produces two runs of it.

        :param batch_id: the batch to match
        :return: the id of the dispatch
        """
        row = self.database.fetch_one(
            """
            INSERT INTO matching_dispatches (batch_id, status)
            VALUES (%s, 'pending')
            ON CONFLICT (batch_id) DO UPDATE SET
                status = CASE WHEN matching_dispatches.status = 'dispatched'
                              THEN 'dispatched' ELSE 'pending' END,
                available_at = NOW(),
                last_error = NULL,
                updated_at = NOW()
            RETURNING dispatch_id
            """,
            (batch_id,),
        )
        return int(row["dispatch_id"]) if row else 0

    def running_count(self) -> int:
        """Return the number of batches that are matched at the moment."""
        value = self.database.fetch_value(
            """
            SELECT count(*) FROM matching_dispatches
            WHERE status IN ('dispatching', 'dispatched')
            """
        )
        return int(value or 0)

    def claim(self, limit: int) -> list[Dispatch]:
        """Take the batches that have to be matched.

        :param limit: how many batches may run at the same time
        :return: the batches that were taken
        """
        free = max(0, limit - self.running_count())
        if free <= 0:
            return []
        rows = self.database.fetch_all(
            """
            WITH candidate AS (
                SELECT dispatch_id
                FROM matching_dispatches
                WHERE status = 'pending' AND available_at <= NOW()
                ORDER BY dispatch_id
                FOR UPDATE SKIP LOCKED
                LIMIT %s
            )
            UPDATE matching_dispatches d
            SET status = 'dispatching',
                locked_at = NOW(),
                locked_by = %s,
                updated_at = NOW()
            FROM candidate c
            WHERE d.dispatch_id = c.dispatch_id
            RETURNING d.dispatch_id, d.batch_id, d.attempts
            """,
            (free, self.worker_id),
        )
        return [
            Dispatch(
                dispatch_id=int(row["dispatch_id"]),
                batch_id=str(row["batch_id"]),
                attempts=int(row["attempts"]),
            )
            for row in rows
        ]

    def mark_dispatched(self, dispatch: Dispatch) -> None:
        """Record that the workflow accepted the batch."""
        self.database.execute(
            """
            UPDATE matching_dispatches
            SET status = 'dispatched', dispatched_at = NOW(), attempts = attempts + 1,
                locked_at = NULL, locked_by = NULL, last_error = NULL, updated_at = NOW()
            WHERE dispatch_id = %s
            """,
            (dispatch.dispatch_id,),
        )

    def mark_failed(self, dispatch: Dispatch, error: str, retry_in: int = 30) -> None:
        """Record that the handover failed.

        A batch that ran out of attempts is marked as failed for good, so it
        does not block the queue.

        :param dispatch: the batch
        :param error: what went wrong
        :param retry_in: seconds until the next attempt
        """
        self.database.execute(
            """
            UPDATE matching_dispatches
            SET status = CASE WHEN attempts + 1 >= %s THEN 'failed' ELSE 'pending' END,
                attempts = attempts + 1,
                last_error = %s,
                available_at = NOW() + (%s || ' seconds')::interval,
                locked_at = NULL,
                locked_by = NULL,
                updated_at = NOW()
            WHERE dispatch_id = %s
            """,
            (
                self.settings.matching.max_attempts,
                error[:2000],
                retry_in,
                dispatch.dispatch_id,
            ),
        )

    def complete(self, batch_id: str) -> int:
        """Record that the matching of a batch is finished."""
        return self.database.execute(
            """
            UPDATE matching_dispatches
            SET status = 'completed', completed_at = NOW(), updated_at = NOW()
            WHERE batch_id = %s AND status <> 'completed'
            """,
            (batch_id,),
        )

    def fail(self, batch_id: str, error: str) -> int:
        """Record that the matching of a batch failed for good."""
        return self.database.execute(
            """
            UPDATE matching_dispatches
            SET status = 'failed', last_error = %s, updated_at = NOW()
            WHERE batch_id = %s AND status <> 'completed'
            """,
            (error[:2000], batch_id),
        )

    # -- the recovery --------------------------------------------------------

    def recover(self) -> int:
        """Bring the dispatches of an interrupted run back into the queue.

        A dispatch that was taken but never handed over is free again, and a
        batch that was handed over but never started is handed over a second
        time.  A batch whose matching is running is left alone.

        :return: the number of recovered dispatches
        """
        expired = self.database.fetch_all(
            """
            UPDATE matching_dispatches
            SET status = 'pending', available_at = NOW(), locked_at = NULL,
                locked_by = NULL, updated_at = NOW()
            WHERE status = 'dispatching'
              AND (locked_at IS NULL OR locked_at < NOW() - (%s || ' seconds')::interval)
            RETURNING dispatch_id
            """,
            (self.settings.matching.lease_seconds,),
        )
        stalled = self.database.fetch_all(
            """
            UPDATE matching_dispatches d
            SET status = 'pending', available_at = NOW(), updated_at = NOW()
            FROM ingestion_batches b
            WHERE d.batch_id = b.batch_id
              AND d.status = 'dispatched'
              AND b.matching_status IN ('pending', 'queued')
              AND d.dispatched_at < NOW() - (%s || ' seconds')::interval
            RETURNING d.dispatch_id
            """,
            (self.settings.matching.lease_seconds,),
        )
        return len(expired) + len(stalled)

    def reconcile(self) -> int:
        """Close the dispatches of the batches whose matching is finished.

        :return: the number of closed dispatches
        """
        done = self.database.fetch_all(
            """
            UPDATE matching_dispatches d
            SET status = 'completed', completed_at = NOW(), updated_at = NOW()
            FROM ingestion_batches b
            WHERE d.batch_id = b.batch_id
              AND d.status = 'dispatched'
              AND (b.matching_status = 'completed' OR b.status = 'failed')
            RETURNING d.dispatch_id
            """
        )
        failed = self.database.fetch_all(
            """
            UPDATE matching_dispatches d
            SET status = 'failed', last_error = COALESCE(b.error, 'the matching of the batch failed'),
                updated_at = NOW()
            FROM ingestion_batches b
            WHERE d.batch_id = b.batch_id
              AND d.status = 'dispatched'
              AND b.status = 'failed'
            RETURNING d.dispatch_id
            """
        )
        return len(done) + len(failed)

    # -- the handover --------------------------------------------------------

    def dispatch(self, dispatch: Dispatch) -> bool:
        """Hand one batch over to the matching workflow.

        :param dispatch: the batch
        :return: True when the workflow accepted the batch
        """
        secret = os.environ.get(
            "RELAY_SHARED_SECRET", self.settings.n8n.relay_shared_secret
        )
        payload = json.dumps({"batch_id": dispatch.batch_id}).encode("utf-8")
        request = urllib.request.Request(
            self.settings.n8n.matching_webhook_url,
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json", "x-relay-secret": secret},
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.settings.matching.webhook_timeout
            ) as response:
                body = response.read().decode("utf-8")
            logger.info("the matching of %s was started: %s", dispatch.batch_id, body[:200])
            self.mark_dispatched(dispatch)
            return True
        except (urllib.error.URLError, OSError, ValueError) as error:
            logger.error("the matching of %s could not be started: %s", dispatch.batch_id, error)
            self.mark_failed(dispatch, str(error))
            return False

    def run_cycle(self) -> dict[str, Any]:
        """Run one round of the dispatcher.

        :return: what the round did
        """
        limit = self.settings.matching.max_concurrency
        self.reconcile()
        self.recover()
        dispatched = 0
        for dispatch in self.claim(limit):
            if self.dispatch(dispatch):
                dispatched += 1
        running = self.running_count()
        self.peak = max(self.peak, running)
        self._record_metrics(running, dispatched)
        return {"dispatched": dispatched, "running": running, "limit": limit}

    def _record_metrics(self, running: int, dispatched: int) -> None:
        """Store the counters of the dispatcher."""
        try:
            self.database.execute(
                """
                INSERT INTO runtime_metrics (metric, value, updated_at)
                VALUES ('matching_dispatch', %s::jsonb, NOW())
                ON CONFLICT (metric) DO UPDATE SET
                    value = EXCLUDED.value, updated_at = NOW()
                """,
                (
                    json.dumps(
                        {
                            "running": running,
                            "peak": self.peak,
                            "dispatched": dispatched,
                            "limit": self.settings.matching.max_concurrency,
                        }
                    ),
                ),
            )
        except Exception:  # noqa: BLE001 - the metrics may not be there yet
            logger.debug("the dispatch metrics could not be stored", exc_info=True)
