"""Forward-only SQL migration runner.

Migrations are plain ``.sql`` files in ``app/db/migrations`` named
``NNN_description.sql``.  They are applied in lexicographic order and tracked
in the ``schema_migrations`` table, so the runner can be executed repeatedly
without re-applying anything.
"""

from __future__ import annotations

import logging
from pathlib import Path

from app.config import MIGRATIONS_DIR

from .session import Database, get_database

logger = logging.getLogger(__name__)

MIGRATION_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT        PRIMARY KEY,
    checksum    TEXT        NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def _checksum(sql: str) -> str:
    import hashlib

    return hashlib.sha256(sql.encode("utf-8")).hexdigest()[:16]


def discover_migrations(directory: Path | None = None) -> list[Path]:
    """Return the migration files in the order they must be applied."""
    folder = directory or MIGRATIONS_DIR
    if not folder.exists():
        return []
    return sorted(path for path in folder.glob("*.sql") if path.is_file())


def applied_versions(database: Database) -> set[str]:
    """Return the set of migration versions already applied."""
    database.execute(MIGRATION_TABLE_DDL)
    rows = database.fetch_all("SELECT version FROM schema_migrations")
    return {row["version"] for row in rows}


def apply_migrations(
    database: Database | None = None, directory: Path | None = None
) -> list[str]:
    """Apply every pending migration and return the versions that ran."""
    db = database or get_database()
    done = applied_versions(db)
    executed: list[str] = []

    for path in discover_migrations(directory):
        version = path.stem
        if version in done:
            continue
        sql = path.read_text(encoding="utf-8")
        logger.info("applying migration %s", version)
        with db.transaction() as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql)
                cursor.execute(
                    "INSERT INTO schema_migrations (version, checksum) VALUES (%s, %s)",
                    (version, _checksum(sql)),
                )
        executed.append(version)
    return executed


def migration_status(database: Database | None = None) -> list[dict[str, str]]:
    """Return the applied state of every known migration."""
    db = database or get_database()
    done = applied_versions(db)
    rows: list[dict[str, str]] = []
    for path in discover_migrations():
        rows.append(
            {
                "version": path.stem,
                "status": "applied" if path.stem in done else "pending",
            }
        )
    return rows
