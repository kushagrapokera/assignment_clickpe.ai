"""Shared fixtures for the test suite.

The end to end test talks to the running stack, so it is skipped when the
stack is not up.  The unit tests run without anything.
"""

from __future__ import annotations

import os
import socket
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.db.session import get_database  # noqa: E402
from app.n8n.admin import N8nAdmin  # noqa: E402
from app.n8n.client import N8nClient  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _port_is_open(host: str, port: int, timeout: float = 1.5) -> bool:
    """Return True when something listens on the port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(timeout)
        return probe.connect_ex((host, port)) == 0


def stack_is_up() -> bool:
    """Return True when n8n, PostgreSQL and Mailpit are reachable."""
    settings = get_settings()
    n8n_host, n8n_port = _split_url(settings.n8n.api_url)
    if not _port_is_open(n8n_host, n8n_port):
        return False
    if not _port_is_open(settings.database.host, settings.database.port):
        return False
    try:
        with urllib.request.urlopen("http://127.0.0.1:8025/api/v1/messages?limit=1", timeout=3):
            return True
    except (urllib.error.URLError, OSError):
        return False


def _split_url(url: str) -> tuple[str, int]:
    """Split a URL into host and port."""
    from urllib.parse import urlparse

    parsed = urlparse(url)
    return parsed.hostname or "127.0.0.1", parsed.port or 80


@pytest.fixture(scope="session")
def settings():
    """The configuration of the stack."""
    return get_settings()


@pytest.fixture(scope="session")
def database():
    """A database connection that is closed at the end of the session."""
    db = get_database()
    yield db
    db.close()


@pytest.fixture(scope="session")
def n8n_admin(settings):
    """An authenticated n8n admin client."""
    if not stack_is_up():
        pytest.skip("the stack is not running")
    admin = N8nAdmin(settings.n8n.api_url)
    admin.login(
        os.environ.get("N8N_OWNER_EMAIL", ""),
        os.environ.get("N8N_OWNER_PASSWORD", ""),
    )
    return admin


@pytest.fixture(scope="session")
def n8n_client(settings):
    """A client for the public n8n API."""
    return N8nClient(settings.n8n.api_url, settings.n8n.api_key)
