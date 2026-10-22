#!/usr/bin/env python3
"""Apply the database migrations.

Usage::

    python3 scripts/migrate.py            # apply pending migrations
    python3 scripts/migrate.py --status   # show the state of each migration
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.migrate import apply_migrations, migration_status  # noqa: E402
from app.db.session import get_database  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--status", action="store_true", help="only report the migration state"
    )
    parser.add_argument(
        "--verbose", action="store_true", help="enable debug level logging"
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    database = get_database()
    try:
        if args.status:
            for row in migration_status(database):
                print(f"{row['status']:>8}  {row['version']}")
            return 0

        executed = apply_migrations(database)
        if executed:
            print(f"applied {len(executed)} migration(s): {', '.join(executed)}")
        else:
            print("database is up to date")
        return 0
    finally:
        database.close()


if __name__ == "__main__":
    raise SystemExit(main())
