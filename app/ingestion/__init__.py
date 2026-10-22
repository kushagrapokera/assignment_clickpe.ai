"""The ingestion of the applicant files."""

from __future__ import annotations

from .csv_parser import (
    EMPLOYMENT_ALIASES,
    RowError,
    ParseResult,
    normalise_employment_status,
    parse_csv,
    validate_row,
)
from .queue import IngestionJob, IngestionQueue, get_queue, new_worker_id
from .storage import ObjectStore, get_object_store
from .store import complete_batch, create_batch, record_row_errors, store_rows
from .worker import IngestionWorker

__all__ = [
    "EMPLOYMENT_ALIASES",
    "IngestionJob",
    "IngestionQueue",
    "IngestionWorker",
    "ObjectStore",
    "ParseResult",
    "RowError",
    "complete_batch",
    "create_batch",
    "get_object_store",
    "get_queue",
    "new_worker_id",
    "normalise_employment_status",
    "parse_csv",
    "record_row_errors",
    "store_rows",
    "validate_row",
]
