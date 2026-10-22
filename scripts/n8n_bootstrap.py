#!/usr/bin/env python3
"""Bootstrap the local n8n instance and mint an API key for the automation stack.

The script is idempotent: it can be re-run at any time.  It performs the
following steps.

1. Creates the owner account on first run (n8n 2.x exposes
   ``POST /rest/owner/setup`` when ``showSetupOnFirstLoad`` is true).
2. Logs in through ``POST /rest/login`` to obtain a session cookie.
3. Reads the API-key scopes that are valid for the owner role.
4. Creates a fresh API key (replacing a previous one with the same label).
5. Writes the key into the project's ``.env`` file as ``N8N_API_KEY``.

Usage::

    python3 scripts/n8n_bootstrap.py            # create/rotate key, update .env
    python3 scripts/n8n_bootstrap.py --print    # only print the key
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import load_dotenv  # noqa: E402
from app.n8n.admin import N8nAdmin  # noqa: E402
from app.n8n.client import N8nError  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = PROJECT_ROOT / ".env"
KEY_LABEL = "assignment-clickpe-mcp"

logger = logging.getLogger("n8n_bootstrap")


def write_env_value(path: Path, key: str, value: str) -> None:
    """Set ``key=value`` in the env file, replacing an existing entry."""
    if not path.exists():
        path.write_text(f"{key}={value}\n", encoding="utf-8")
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    replaced = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.split("=", 1)[0].strip() == key:
            lines[index] = f"{key}={value}"
            replaced = True
            break
    if not replaced:
        lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--print",
        dest="print_only",
        action="store_true",
        help="print the key instead of writing it to .env",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    load_dotenv(ENV_PATH)

    import os

    base_url = os.environ.get("N8N_API_URL", "")
    email = os.environ.get("N8N_OWNER_EMAIL", "")
    password = os.environ.get("N8N_OWNER_PASSWORD", "")
    if not base_url or not email or not password:
        print(
            "error: N8N_API_URL, N8N_OWNER_EMAIL and N8N_OWNER_PASSWORD are required",
            file=sys.stderr,
        )
        return 2

    admin = N8nAdmin(base_url)
    try:
        if admin.ensure_owner(email, password):
            logger.info("owner account created: %s", email)
        admin.login(email, password)
        removed = admin.delete_api_keys(KEY_LABEL)
        if removed:
            logger.info("removed %s previous API key(s)", removed)
            admin.login(email, password)
        api_key = admin.create_api_key(KEY_LABEL, admin.valid_scopes())
    except N8nError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.print_only:
        print(api_key)
    else:
        write_env_value(ENV_PATH, "N8N_API_KEY", api_key)
        logger.info("N8N_API_KEY written to %s", ENV_PATH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
