"""Thin psycopg2 wrapper used by the ingestion service and the CLI scripts."""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Iterator, Sequence

import psycopg2
import psycopg2.extras

from app.config import DatabaseSettings, get_settings

logger = logging.getLogger(__name__)


class Database:
    """Small connection helper around psycopg2.

    The class keeps a single connection alive and re-opens it lazily.  Every
    public method accepts and returns plain Python structures so the rest of
    the code never has to think about cursors.
    """

    def __init__(self, settings: DatabaseSettings | None = None) -> None:
        self._settings = settings or get_settings().database
        self._connection: psycopg2.extensions.connection | None = None

    # -- connection handling -------------------------------------------------

    def connect(self) -> psycopg2.extensions.connection:
        """Return a live connection, opening one when needed."""
        if self._connection is None or self._connection.closed:
            logger.debug("opening database connection: %s", self._settings.safe_dsn())
            self._connection = psycopg2.connect(self._settings.dsn)
            self._connection.autocommit = False
        return self._connection

    def close(self) -> None:
        """Close the connection if one is open."""
        if self._connection is not None and not self._connection.closed:
            self._connection.close()
        self._connection = None

    @contextmanager
    def transaction(self) -> Iterator[psycopg2.extensions.connection]:
        """Run a block inside a transaction, rolling back on failure."""
        connection = self.connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise

    # -- query helpers -------------------------------------------------------

    def execute(self, sql: str, params: Sequence[Any] | None = None) -> int:
        """Execute a statement and return the number of affected rows."""
        with self.transaction() as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql, params)
                return cursor.rowcount

    def fetch_all(self, sql: str, params: Sequence[Any] | None = None) -> list[dict[str, Any]]:
        """Run a query and return every row as a dictionary."""
        with self.transaction() as connection:
            with connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute(sql, params)
                return [dict(row) for row in cursor.fetchall()]

    def fetch_one(
        self, sql: str, params: Sequence[Any] | None = None
    ) -> dict[str, Any] | None:
        """Run a query and return the first row as a dictionary."""
        rows = self.fetch_all(sql, params)
        return rows[0] if rows else None

    def fetch_value(self, sql: str, params: Sequence[Any] | None = None) -> Any:
        """Run a query and return the first column of the first row."""
        row = self.fetch_one(sql, params)
        if not row:
            return None
        return next(iter(row.values()))


_database: Database | None = None


def get_database() -> Database:
    """Return the process wide database helper."""
    global _database
    if _database is None:
        _database = Database()
    return _database
