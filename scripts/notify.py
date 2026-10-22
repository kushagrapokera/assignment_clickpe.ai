#!/usr/bin/env python3
"""Trigger the notification workflow for a batch.

Usage::

    python3 scripts/notify.py <batch-id>
    python3 scripts/notify.py --latest
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.db.session import get_database  # noqa: E402

logger = logging.getLogger("notify")


def latest_batch_id() -> str | None:
    """Return the most recent ingestion batch id."""
    database = get_database()
    try:
        row = database.fetch_one(
            "SELECT batch_id FROM ingestion_batches ORDER BY created_at DESC LIMIT 1"
        )
        return str(row["batch_id"]) if row else None
    finally:
        database.close()


def call_webhook(url: str, payload: dict, secret: str, timeout: float = 300.0) -> dict:
    """Call the notification webhook and return the parsed answer."""
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "x-relay-secret": secret},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:600]
        raise RuntimeError(f"the workflow answered with HTTP {exc.code}: {detail}") from exc
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"raw": body}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batch_id", nargs="?", help="batch to notify")
    parser.add_argument("--latest", action="store_true", help="use the newest batch")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    settings = get_settings()

    batch_id = args.batch_id
    if args.latest or not batch_id:
        batch_id = latest_batch_id()
    if not batch_id:
        print("error: no batch to notify", file=sys.stderr)
        return 1

    url = settings.n8n.notification_webhook_url
    secret = os.environ.get("RELAY_SHARED_SECRET", settings.n8n.relay_shared_secret)
    logger.info("triggering %s for batch %s", url, batch_id)

    started = time.time()
    answer = call_webhook(url, {"batch_id": batch_id}, secret)
    elapsed = time.time() - started

    print(json.dumps(answer, indent=2, default=str))
    print(f"\nwall clock: {elapsed:.1f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
