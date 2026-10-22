#!/usr/bin/env python3
"""Push the built workflows into the n8n instance.

The script is idempotent: workflows are matched by name and updated in
place.  It also (re)creates the PostgreSQL credential that the workflows
reference, so the instance is fully configured from the repository.

Usage::

    python3 scripts/import_workflows.py                # create or update
    python3 scripts/import_workflows.py --activate     # and activate them
    python3 scripts/import_workflows.py --only workflow_a_discovery.json
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.n8n.admin import N8nAdmin  # noqa: E402
from app.n8n.client import N8nClient, N8nError  # noqa: E402

WORKFLOW_DIR = Path(__file__).resolve().parents[1] / "n8n" / "workflows"
CREDENTIAL_PLACEHOLDER = "__CREDENTIAL__:postgres"
CREDENTIAL_NAME = "Loan Engine PostgreSQL"
OLLAMA_CREDENTIAL_PLACEHOLDER = "__CREDENTIAL__:ollama"
OLLAMA_CREDENTIAL_NAME = "Ollama API"
RELAY_CREDENTIAL_PLACEHOLDER = "__CREDENTIAL__:relay"
RELAY_CREDENTIAL_NAME = "Relay Secret"
SMTP_CREDENTIAL_PLACEHOLDER = "__CREDENTIAL__:smtp"
SMTP_CREDENTIAL_NAME = "Loan Engine Mail"

logger = logging.getLogger("import_workflows")


def ensure_credential(admin: N8nAdmin) -> str:
    """Create the PostgreSQL credential and return its id."""
    settings = get_settings()
    database = settings.database
    # Inside the compose network the database is reachable by service name.
    host = database.host
    if host in {"127.0.0.1", "localhost"}:
        host = "postgres"
    # The local container serves plain TCP; a managed RDS instance wants TLS.
    use_tls = database.sslmode in {"require", "verify-ca", "verify-full"}
    data = {
        "host": host,
        "port": database.port,
        "database": database.database,
        "user": database.user,
        "password": database.password,
        "allowUnauthorizedCerts": use_tls,
        "ssl": "require" if use_tls else "disable",
    }

    for credential in admin.list_credentials():
        if credential.get("name") == CREDENTIAL_NAME:
            admin.delete_credential(credential["id"])
            logger.info("removed previous credential %s", credential["id"])

    created = admin.create_credential(CREDENTIAL_NAME, "postgres", data)
    logger.info("created credential %s", created.get("id"))
    return created["id"]


def ensure_ollama_credential(admin: N8nAdmin) -> str:
    """Create the header credential used for the LLM and return its id."""
    settings = get_settings()
    if not settings.llm.api_key:
        print("warning: OLLAMA_API_KEY is not set, the LLM credential will be empty")
    # The Ollama API speaks the OpenAI protocol and expects a bearer token.
    data = {"token": settings.llm.api_key}

    for credential in admin.list_credentials():
        if credential.get("name") == OLLAMA_CREDENTIAL_NAME:
            admin.delete_credential(credential["id"])
            logger.info("removed previous credential %s", credential["id"])

    created = admin.create_credential(OLLAMA_CREDENTIAL_NAME, "httpBearerAuth", data)
    logger.info("created credential %s", created.get("id"))
    return created["id"]


def ensure_relay_credential(admin: N8nAdmin) -> str:
    """Create the header credential with the shared secret of the relay."""
    secret = os.environ.get("RELAY_SHARED_SECRET", "")
    data = {"name": "x-relay-secret", "value": secret}

    for credential in admin.list_credentials():
        if credential.get("name") == RELAY_CREDENTIAL_NAME:
            admin.delete_credential(credential["id"])
            logger.info("removed previous credential %s", credential["id"])

    created = admin.create_credential(RELAY_CREDENTIAL_NAME, "httpHeaderAuth", data)
    logger.info("created credential %s", created.get("id"))
    return created["id"]


def ensure_smtp_credential(
    admin: N8nAdmin,
    host: str | None = None,
    port: int | None = None,
    secure: bool | None = None,
) -> str:
    """Create the SMTP credential the notification workflow uses.

    Locally the mail goes to Mailpit, which the n8n container reaches under
    its compose service name.  In production the same credential points at
    the SMTP endpoint of Amazon SES.

    The host, the port and the encryption can be given on the command line,
    so a benchmark can use the local mail sink instead of a provider with a
    daily quota.  The local sink speaks plain SMTP, so it never uses TLS.
    """
    settings = get_settings()
    notification = settings.notification
    resolved = host or notification.smtp_host
    if resolved in {"127.0.0.1", "localhost"}:
        resolved = "mailpit"
    local = resolved == "mailpit"
    data = {
        "host": resolved,
        "port": int(port or (1025 if local else notification.smtp_port)),
        "secure": (False if local else notification.smtp_secure) if secure is None else bool(secure),
        "user": notification.smtp_user,
        "password": notification.smtp_password,
        "disableStartTls": False,
    }

    for credential in admin.list_credentials():
        if credential.get("name") == SMTP_CREDENTIAL_NAME:
            admin.delete_credential(credential["id"])
            logger.info("removed previous credential %s", credential["id"])

    created = admin.create_credential(SMTP_CREDENTIAL_NAME, "smtp", data)
    logger.info("created credential %s", created.get("id"))
    return created["id"]


def load_workflow(
    path: Path,
    credential_id: str,
    ollama_credential_id: str,
    relay_credential_id: str,
    smtp_credential_id: str,
) -> dict:
    """Load a workflow file and bind the credentials it uses."""
    raw = path.read_text(encoding="utf-8")
    raw = raw.replace(CREDENTIAL_PLACEHOLDER, credential_id)
    raw = raw.replace(OLLAMA_CREDENTIAL_PLACEHOLDER, ollama_credential_id)
    raw = raw.replace(RELAY_CREDENTIAL_PLACEHOLDER, relay_credential_id)
    raw = raw.replace(SMTP_CREDENTIAL_PLACEHOLDER, smtp_credential_id)
    workflow = json.loads(raw)
    # The public API only accepts a fixed set of fields.
    for field in (
        "id",
        "createdAt",
        "updatedAt",
        "versionId",
        "owner",
        "tags",
        "meta",
        "active",
        "isArchived",
    ):
        workflow.pop(field, None)
    return workflow


def upsert_workflow(client: N8nClient, workflow: dict) -> dict:
    """Create or update a workflow, matching on the workflow name."""
    existing = {item["name"]: item for item in client.list_workflows()}
    if workflow["name"] in existing:
        workflow_id = existing[workflow["name"]]["id"]
        updated = client.update_workflow(workflow_id, workflow)
        logger.info("updated workflow %s (%s)", workflow["name"], workflow_id)
        return updated
    created = client.create_workflow(workflow)
    logger.info("created workflow %s (%s)", workflow["name"], created.get("id"))
    return created


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--activate", action="store_true", help="activate the workflows after import"
    )
    parser.add_argument(
        "--only", action="append", default=[], help="import only the given file name(s)"
    )
    parser.add_argument(
        "--deactivate",
        action="store_true",
        help="deactivate the workflows instead of activating them",
    )
    parser.add_argument(
        "--smtp-host",
        default=None,
        help="host of the mail server, for example mailpit for the local sink",
    )
    parser.add_argument(
        "--smtp-port",
        type=int,
        default=None,
        help="port of the mail server",
    )
    parser.add_argument(
        "--smtp-secure",
        dest="smtp_secure",
        action="store_true",
        default=None,
        help="use TLS for the mail server",
    )
    parser.add_argument(
        "--no-smtp-secure",
        dest="smtp_secure",
        action="store_false",
        help="do not use TLS for the mail server",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    settings = get_settings()
    if not settings.n8n.api_key:
        print("error: N8N_API_KEY is not configured", file=sys.stderr)
        return 2

    client = N8nClient(settings.n8n.api_url, settings.n8n.api_key)
    admin = N8nAdmin(settings.n8n.api_url)

    try:
        admin.login(
            os.environ.get("N8N_OWNER_EMAIL", ""),
            os.environ.get("N8N_OWNER_PASSWORD", ""),
        )
        credential_id = ensure_credential(admin)
        ollama_credential_id = ensure_ollama_credential(admin)
        relay_credential_id = ensure_relay_credential(admin)
        smtp_credential_id = ensure_smtp_credential(
            admin, host=args.smtp_host, port=args.smtp_port, secure=args.smtp_secure
        )
        files = sorted(WORKFLOW_DIR.glob("*.json"))
        if args.only:
            files = [path for path in files if path.name in args.only]
        if not files:
            print("no workflow files found", file=sys.stderr)
            return 1

        for path in files:
            workflow = load_workflow(
                path,
                credential_id,
                ollama_credential_id,
                relay_credential_id,
                smtp_credential_id,
            )
            result = upsert_workflow(client, workflow)
            workflow_id = result.get("id")
            if args.activate and workflow_id:
                client.activate_workflow(workflow_id)
                logger.info("activated %s", workflow["name"])
            elif args.deactivate and workflow_id:
                client.deactivate_workflow(workflow_id)
                logger.info("deactivated %s", workflow["name"])
        return 0
    except N8nError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
