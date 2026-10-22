#!/usr/bin/env python3
"""Run a worker that processes the ingestion queue.

Usage::

    python3 scripts/worker.py
    python3 scripts/worker.py --once    # process one job and stop
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ingestion.worker import IngestionWorker  # noqa: E402

logger = logging.getLogger("worker")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--once", action="store_true", help="process a single job and stop"
    )
    parser.add_argument(
        "--poll",
        type=float,
        default=2.0,
        help="seconds to wait when the queue is empty",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    worker = IngestionWorker()
    if args.once:
        job = worker.queue.claim(worker.worker_id)
        if job is None:
            logger.info("there is no work on the queue")
            return 0
        worker.process(job)
        return 0

    logger.info("worker %s is waiting for work", worker.worker_id)
    try:
        worker.run_forever(poll_seconds=args.poll)
    except KeyboardInterrupt:
        logger.info("the worker is stopping")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
