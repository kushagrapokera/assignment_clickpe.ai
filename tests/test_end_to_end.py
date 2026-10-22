"""The end to end test: from the scheduler of Workflow A to the inbox.

The test drives the same entry points the production system uses:

* the Schedule Trigger of Workflow A, exactly the node the cron fires,
* the ingestion of an applicant file,
* the webhook of Workflow B, which triggers Workflow C,
* the mail server, which is where the notifications end up.

It is skipped when the stack is not running.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from app.config import get_settings
from app.ingestion.csv_parser import parse_csv
from app.n8n.admin import N8nAdmin
from app.n8n.execution import decode_execution_data
from app.ingestion.store import (
    complete_batch,
    create_batch,
    record_row_errors,
    store_rows,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SAMPLE_CSV = PROJECT_ROOT / "samples" / "users_small.csv"
MAILPIT_API = "http://127.0.0.1:8025/api/v1"

pytestmark = pytest.mark.e2e


def _wait_for_execution(admin, workflow_id: str, previous: str | None, timeout: float = 180.0):
    """Wait until the execution that was just triggered has finished.

    Only the newest execution of the workflow counts.  Returning any older
    finished execution would let the test continue while the crawl is still
    writing its results.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        for execution in admin.list_executions(limit=25):
            if execution.get("workflowId") != workflow_id:
                continue
            if previous and str(execution.get("id")) == previous:
                continue
            if execution.get("finished") or execution.get("stoppedAt"):
                return execution
            # The newest execution is still running, wait for it.
            break
        time.sleep(1.0)
    raise AssertionError(f"no finished execution of {workflow_id} within {timeout}s")


def _latest_execution_id(admin, workflow_id: str) -> str | None:
    """Return the id of the most recent execution of a workflow."""
    for execution in admin.list_executions(limit=25):
        if execution.get("workflowId") == workflow_id:
            return str(execution.get("id"))
    return None


def _post(url: str, payload: dict, secret: str, timeout: float = 300.0) -> dict:
    """Call a webhook and return the parsed answer."""
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "x-relay-secret": secret},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    return json.loads(body) if body.strip() else {}


def _as_epoch(value) -> float | None:
    """Return a timestamp of the execution as seconds since the epoch."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    from datetime import datetime

    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


API_URL = os.environ.get("API_URL", "http://127.0.0.1:8000")


def _get(url: str, timeout: float = 30.0) -> dict:
    """Read a document from the API."""
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _upload(path: Path) -> str | None:
    """Upload a file through the HTTP interface and return the upload id."""
    boundary = "----loanengineboundary"
    payload = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="users.csv"\r\n'
        "Content-Type: text/csv\r\n\r\n"
    ).encode("utf-8") + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode("utf-8")
    request = urllib.request.Request(
        f"{API_URL}/api/uploads",
        data=payload,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8")).get("upload_id")


def _statistics(batch_id: str) -> dict:
    """The statistics of the matching run of a batch.

    The run is read from the execution of n8n, because the webhook answers
    at once and the matching happens in the background.
    """
    return _statistics_from_execution(batch_id)


def _statistics_from_execution(batch_id: str) -> dict:
    """Read the statistics of the last matching execution of a batch."""
    settings = get_settings()
    admin = N8nAdmin(settings.n8n.api_url)
    admin.login(
        os.environ.get("N8N_OWNER_EMAIL", ""),
        os.environ.get("N8N_OWNER_PASSWORD", ""),
    )
    empty = {"pairs_total": 0, "matches_total": 0, "llm_unparsed": 0}
    for execution in admin.list_executions(limit=25):
        if (execution.get("workflowName") or "") != "Workflow B - User Loan Matching":
            continue
        data = decode_execution_data(admin.execution(str(execution["id"])).get("data"))
        nodes = (data.get("resultData") or {}).get("runData") or {}

        # The run belongs to the batch when the request carried its id.
        belongs = False
        for run in nodes.get("Validate Request", []):
            for branch in (run.get("data") or {}).get("main") or []:
                for item in branch or []:
                    if item.get("json", {}).get("batch_id") == batch_id:
                        belongs = True
        if not belongs:
            continue

        for run in nodes.get("Summarise Run", []):
            for branch in (run.get("data") or {}).get("main") or []:
                for item in branch or []:
                    statistics = item.get("json", {}).get("statistics", {})
                    if statistics:
                        return statistics
    return empty


def _mailpit_messages() -> list[dict]:
    """Return the messages of the local mail server."""
    with urllib.request.urlopen(f"{MAILPIT_API}/messages?limit=50", timeout=10) as response:
        return json.loads(response.read().decode("utf-8")).get("messages", [])


def _reset(database) -> None:
    """Empty the tables the pipeline fills."""
    database.execute(
        "TRUNCATE matches, matching_decisions, llm_verdict_cache, notifications, "
        "users, ingestion_queue, ingestion_batches, ingestion_row_errors, "
        "ingestion_uploads, matching_dispatches, matching_runs, runtime_metrics, "
        "loan_products, discovery_runs RESTART IDENTITY"
    )


def test_full_pipeline_from_the_scheduler(
    n8n_admin, n8n_client, database, settings
):
    """Workflow A (scheduled) -> ingestion -> Workflow B -> Workflow C."""
    import os

    secret = os.environ.get("RELAY_SHARED_SECRET", settings.n8n.relay_shared_secret)

    workflows = {w["name"]: w for w in n8n_client.list_workflows()}
    assert "Workflow A - Loan Product Discovery" in workflows
    assert "Workflow B - User Loan Matching" in workflows

    discovery = workflows["Workflow A - Loan Product Discovery"]
    matching = workflows["Workflow B - User Loan Matching"]

    # ------------------------------------------------------------------
    # 1. the scheduled crawl of Workflow A
    # ------------------------------------------------------------------
    _reset(database)
    previous = _latest_execution_id(n8n_admin, discovery["id"])
    n8n_admin.run_workflow(discovery["id"], "Schedule Trigger")
    execution = _wait_for_execution(n8n_admin, discovery["id"], previous)
    assert execution["status"] == "success", "the scheduled crawl failed"

    products = database.fetch_all(
        "SELECT provider, product_key, criteria_signature, variants, active "
        "FROM loan_products WHERE active ORDER BY provider"
    )
    assert len(products) >= 15, "the crawl did not store the product catalogue"
    assert all(row["provider"] for row in products)
    assert len({row["product_key"] for row in products}) == len(products)

    runs = database.fetch_all(
        "SELECT source_id, status, products_found, products_collapsed "
        "FROM discovery_runs ORDER BY source_id"
    )
    assert runs, "the discovery run log is empty"
    assert all(row["status"] == "success" for row in runs)

    # The six pages of the same lender collapse into one product, and the
    # provenance of the merged pages is kept.
    merged = [row for row in products if row["variants"]]
    assert merged, "no product kept the variants of the merged pages"
    for row in merged:
        assert len(row["variants"]) >= 1

    # ------------------------------------------------------------------
    # 2. the upload of an applicant file through the HTTP interface
    # ------------------------------------------------------------------
    parsed = parse_csv(SAMPLE_CSV)
    assert parsed.accepted_rows > 0
    assert parsed.rejected_rows == 0, "the sample file must load without errors"

    upload_id = _upload(SAMPLE_CSV)
    assert upload_id, "the upload was refused"

    # The worker picks the file up, splits it into batches and starts the
    # matching of every batch.
    deadline = time.time() + 240
    batches = []
    while time.time() < deadline:
        answer = _get(f"{API_URL}/api/uploads/{upload_id}")
        batches = answer.get("batches") or []
        if batches and all(batch["matches"] > 0 for batch in batches):
            break
        time.sleep(3.0)
    assert batches, "the worker did not process the upload"
    assert all(batch["matches"] > 0 for batch in batches), (
        "not every batch was matched: "
        f"{[(b['batch_id'][:8], b['matches']) for b in batches]}"
    )

    batch_id = batches[0]["batch_id"]

    # ------------------------------------------------------------------
    # 3. the matching of Workflow B, which triggers Workflow C
    # ------------------------------------------------------------------
    # The matching of the batch was already started by the worker, so the
    # webhook is only called here to prove that it answers at once.
    answer = _post(
        settings.n8n.matching_webhook_url, {"batch_id": batch_id}, secret
    )
    assert answer.get("status") == "accepted", "the webhook did not acknowledge"

    matching_statistics = _statistics(batch_id)
    assert matching_statistics["pairs_total"] > 0
    assert matching_statistics["matches_total"] > 0
    assert matching_statistics["llm_unparsed"] == 0

    # ------------------------------------------------------------------
    # 4. what the pipeline wrote
    # ------------------------------------------------------------------
    matches = database.fetch_all(
        "SELECT status, decided_by, count(*) AS total FROM matches "
        "WHERE batch_id = %s GROUP BY 1, 2",
        (batch_id,),
    )
    assert matches, "no match was written"
    assert sum(row["total"] for row in matches) == matching_statistics["matches_total"]
    # Only a confirmed eligibility is stored as a match.
    assert all(row["status"] == "eligible" for row in matches)

    notifications = database.fetch_all(
        "SELECT user_id, recipient, status FROM notifications ORDER BY notification_id"
    )
    assert notifications, "no notification was recorded"
    assert all(row["status"] == "sent" for row in notifications)

    allowed = {
        row["address"]
        for row in database.fetch_all(
            "SELECT address FROM notification_recipients WHERE active"
        )
    }
    assert allowed, "the allow list of the recipients is empty"
    for row in notifications:
        assert row["recipient"] in allowed, "a notification left the allow list"

    # ------------------------------------------------------------------
    # 5. the inbox
    # ------------------------------------------------------------------
    messages = _mailpit_messages()
    assert messages, "no mail arrived"
    recent = messages[: len(notifications)]
    for message in recent:
        recipients = [
            entry["Address"] for entry in (message.get("To") or []) if entry.get("Address")
        ]
        assert recipients, "a mail without a recipient arrived"
        for address in recipients:
            assert address in allowed, f"a mail was sent to {address}"
            assert not address.endswith("@example.com"), (
                "an address of the applicant file was mailed"
            )
        assert message.get("Subject"), "a mail without a subject arrived"

    print(
        "\n  pipeline: "
        f"{len(products)} products, "
        f"{matching_statistics['pairs_total']} pairs, "
        f"{matching_statistics['matches_total']} matches, "
        f"{len(notifications)} emails, "
        f"{matching_statistics['llm_requests']} LLM calls"
    )


@pytest.mark.slow
def test_the_scheduler_fires_on_its_own(n8n_admin, n8n_client):
    """The cron of Workflow A starts the crawl without anybody asking."""
    workflows = {w["name"]: w for w in n8n_client.list_workflows()}
    discovery = workflows["Workflow A - Loan Product Discovery"]

    # A run that the scheduler started has the mode "trigger", a run that a
    # person started has the mode "manual".  Only runs that started after
    # this test counts, an old run of the scheduler proves nothing.
    started_at = time.time()
    deadline = started_at + 380
    while time.time() < deadline:
        for execution in n8n_admin.list_executions(limit=50):
            if execution.get("workflowId") != discovery["id"]:
                continue
            if execution.get("mode") != "trigger":
                continue
            began = _as_epoch(execution.get("startedAt"))
            if began is None or began < started_at:
                continue
            if execution.get("finished") or execution.get("stoppedAt"):
                assert execution.get("status") == "success"
                return
        time.sleep(5.0)
    raise AssertionError("the scheduler did not start a run within 380 seconds")
