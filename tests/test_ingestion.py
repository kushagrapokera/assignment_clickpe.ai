"""Tests for the ingestion: the queue, the object store and the HTTP interface.

The tests that need the stack are skipped when it is not running.
"""

from __future__ import annotations

import io
import json
import urllib.request
import uuid
from pathlib import Path

import pytest

from app.config import get_settings
from app.ingestion.queue import LocalIngestionQueue, new_worker_id
from app.ingestion.storage import LocalObjectStore

PROJECT_ROOT = Path(__file__).resolve().parents[1]


# -- the queue ---------------------------------------------------------------


def test_a_job_is_claimed_only_once(database):
    """Two workers must never work on the same job."""
    queue = LocalIngestionQueue(database)
    upload_id = str(uuid.uuid4())
    database.execute(
        """
        INSERT INTO ingestion_uploads (upload_id, filename, status)
        VALUES (%s, 'test.csv', 'queued')
        """,
        (upload_id,),
    )
    queue.enqueue(upload_id, {"object_key": "uploads/x/test.csv", "filename": "test.csv"})

    first = queue.claim(new_worker_id())
    second = queue.claim(new_worker_id())

    assert first is not None
    assert first.upload_id == upload_id
    assert first.object_key == "uploads/x/test.csv"
    assert second is None, "the job was handed out twice"

    queue.complete(first)
    database.execute("DELETE FROM ingestion_uploads WHERE upload_id = %s", (upload_id,))


def test_a_failed_job_comes_back(database):
    """A job that failed is offered again, until it ran out of attempts."""
    queue = LocalIngestionQueue(database)
    upload_id = str(uuid.uuid4())
    database.execute(
        """
        INSERT INTO ingestion_uploads (upload_id, filename, status)
        VALUES (%s, 'test.csv', 'queued')
        """,
        (upload_id,),
    )
    queue.enqueue(upload_id, {"object_key": "uploads/y/test.csv"})

    job = queue.claim(new_worker_id())
    assert job is not None
    queue.fail(job, "something went wrong", retry_in=0)

    again = queue.claim(new_worker_id())
    assert again is not None, "the job did not come back"
    assert again.attempts == 2
    database.execute("DELETE FROM ingestion_uploads WHERE upload_id = %s", (upload_id,))


# -- the object store --------------------------------------------------------


def test_the_object_store_round_trips(tmp_path):
    """What is written comes back unchanged."""
    store = LocalObjectStore(tmp_path / "objects")
    payload = b"user_id,email\na,b@c.test\n"

    size = store.put("uploads/abc/file.csv", io.BytesIO(payload), max_bytes=1024)
    assert size == len(payload)
    assert store.exists("uploads/abc/file.csv")
    with store.open("uploads/abc/file.csv") as stream:
        assert stream.read() == payload


def test_the_object_store_refuses_a_file_that_is_too_big(tmp_path):
    """A file above the limit is not stored."""
    store = LocalObjectStore(tmp_path / "objects")
    with pytest.raises(ValueError):
        store.put("uploads/abc/big.csv", io.BytesIO(b"x" * 2048), max_bytes=1024)
    assert not store.exists("uploads/abc/big.csv")


# -- the HTTP interface ------------------------------------------------------


def _api_is_up() -> bool:
    try:
        with urllib.request.urlopen(
            f"{_api_url()}/api/health", timeout=3
        ) as response:
            return response.status == 200
    except Exception:  # noqa: BLE001 - the stack may be down
        return False


def _api_url() -> str:
    import os

    return os.environ.get("API_URL", "http://127.0.0.1:8000")


@pytest.mark.skipif(not _api_is_up(), reason="the service is not running")
def test_the_health_check():
    with urllib.request.urlopen(f"{_api_url()}/api/health", timeout=10) as response:
        answer = json.loads(response.read().decode("utf-8"))
    assert answer["status"] == "ok"
    assert answer["products"] >= 0


@pytest.mark.skipif(not _api_is_up(), reason="the service is not running")
def test_a_file_that_is_not_a_csv_is_refused():
    boundary = "----loanengineboundary"
    payload = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="notes.txt"\r\n'
        "Content-Type: text/plain\r\n\r\n"
        "hello"
        f"\r\n--{boundary}--\r\n"
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{_api_url()}/api/uploads",
        data=payload,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(request, timeout=30)
    assert error.value.code == 400


@pytest.mark.skipif(not _api_is_up(), reason="the service is not running")
def test_the_upload_page_is_served():
    with urllib.request.urlopen(f"{_api_url()}/", timeout=10) as response:
        page = response.read().decode("utf-8")
    assert "Loan Eligibility Engine" in page
    assert "/static/app.js" in page
