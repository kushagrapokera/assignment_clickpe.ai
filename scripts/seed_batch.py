#!/usr/bin/env python3
"""Load a CSV file into the database as an ingestion batch.

The script uses the same code as the upload service, so it is a faithful
stand in for the ingestion pipeline.

Usage::

    python3 scripts/seed_batch.py samples/users.csv
    python3 scripts/seed_batch.py samples/users.csv --rows 500
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import get_database  # noqa: E402
from app.ingestion.csv_parser import parse_csv  # noqa: E402
from app.ingestion.store import (  # noqa: E402
    complete_batch,
    create_batch,
    record_row_errors,
    store_rows,
)

logger = logging.getLogger("seed_batch")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", help="path of the CSV file")
    parser.add_argument("--rows", type=int, default=None, help="only load this many rows")
    parser.add_argument("--batch-id", default=None, help="use a fixed batch id")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    path = Path(args.csv)
    result = parse_csv(path, max_rows=args.rows)
    logger.info(
        "parsed %s rows: %s accepted, %s rejected",
        result.total_rows,
        result.accepted_rows,
        result.rejected_rows,
    )
    for error in result.errors[:5]:
        logger.warning("row %s: %s", error.row_number, error.message)

    database = get_database()
    try:
        batch_id = create_batch(
            database,
            filename=path.name,
            object_key=f"local://{path.name}",
            batch_id=args.batch_id,
        )
        written = store_rows(batch_id, result.rows, database)
        record_row_errors(batch_id, result.errors, database)
        complete_batch(
            batch_id,
            total_rows=result.total_rows,
            accepted_rows=written,
            rejected_rows=len(result.errors),
            unique_emails=result.unique_emails,
            database=database,
        )
        logger.info("batch %s stored with %s rows", batch_id, written)
        print(json.dumps({"batch_id": batch_id, "rows": written}))
        return 0
    finally:
        database.close()


if __name__ == "__main__":
    raise SystemExit(main())
