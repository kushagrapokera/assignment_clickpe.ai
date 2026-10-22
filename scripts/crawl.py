#!/usr/bin/env python3
"""Run the discovery crawl through n8n and print what was extracted.

The command triggers "Workflow A - Loan Product Discovery" on the running n8n
instance, waits for the execution to finish and prints a single JSON document
with everything the crawler extracted.

Usage::

    python3 scripts/crawl.py                     # crawl and print the result
    python3 scripts/crawl.py --out crawl.json    # also write it to a file
    python3 scripts/crawl.py --quiet             # only print the JSON
    python3 scripts/crawl.py --source bankbazaar # crawl a single source
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.discovery.snapshots import DEFAULT_SNAPSHOT_DIR, write_snapshots  # noqa: E402
from app.n8n.admin import N8nAdmin  # noqa: E402
from app.n8n.client import N8nError  # noqa: E402
from app.n8n.execution import (  # noqa: E402
    decode_execution_data,
    execution_summary,
    node_output,
)

WORKFLOW_NAME = "Workflow A - Loan Product Discovery"
TRIGGER_NODE = "Schedule Trigger"
EXTRACT_NODE = "Extract Products"
PAYLOAD_NODE = "Build Upsert Payload"
PERSIST_NODE = "Persist Products And Run Log"


def find_workflow(admin: N8nAdmin, name: str) -> dict[str, Any]:
    """Return the workflow with the given name."""
    for workflow in admin.list_workflows():
        if workflow.get("name") == name:
            return workflow
    raise N8nError(
        f"workflow '{name}' not found. Run 'python3 scripts/import_workflows.py' first."
    )


def latest_execution_id(admin: N8nAdmin, workflow_id: str) -> str | None:
    """Return the id of the most recent execution of a workflow."""
    executions = admin.list_executions(limit=25)
    for execution in executions:
        if execution.get("workflowId") == workflow_id:
            return str(execution.get("id"))
    return None


def wait_for_execution(
    admin: N8nAdmin,
    workflow_id: str,
    previous_id: str | None,
    timeout: float,
) -> dict[str, Any]:
    """Wait until the newest execution of the workflow has finished.

    Only the newest execution is considered: an older, already finished
    execution would otherwise be returned while the new one is still running.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        executions = admin.list_executions(limit=25)
        candidate = None
        for execution in executions:
            if execution.get("workflowId") != workflow_id:
                continue
            execution_id = str(execution.get("id"))
            if previous_id and execution_id == previous_id:
                continue
            candidate = execution
            break
        if candidate is not None and (
            candidate.get("finished") or candidate.get("stoppedAt")
        ):
            return admin.execution(str(candidate.get("id")))
        time.sleep(1.5)
    raise N8nError(f"the workflow did not finish within {timeout:.0f}s")


def build_report(execution: dict[str, Any], source_filter: str | None) -> dict[str, Any]:
    """Turn the execution data into the report that is printed as JSON.

    The report shows the *canonical* catalogue - the products that were
    written to the database.  The raw extraction count and the products that
    were merged away are reported as well, so the crawl is fully traceable.
    """
    data = decode_execution_data(execution.get("data"))
    source = data if data.get("resultData") else execution

    extracted = node_output(source, EXTRACT_NODE)
    payloads = node_output(source, PAYLOAD_NODE)
    persisted = node_output(source, PERSIST_NODE)

    payload = payloads[0] if payloads else {}
    products = payload.get("products") or []
    failures = [
        {
            "source_id": item.get("source_id"),
            "reason": item.get("crawl_error"),
        }
        for item in extracted
        if item.get("product_error")
    ]

    if source_filter:
        products = [
            product
            for product in products
            if source_filter in str(product.get("source_id", ""))
            or source_filter in str(product.get("provider", ""))
        ]

    # Per source summary, so the report shows what each publisher contributed.
    by_source: dict[str, dict[str, Any]] = {}
    for product in products:
        source_id = str(product.get("source_id", "unknown"))
        entry = by_source.setdefault(
            source_id,
            {
                "source_id": source_id,
                "source_name": product.get("source_name"),
                "source_url": product.get("source_url"),
                "products": 0,
                "providers": [],
            },
        )
        entry["products"] += 1
        provider = product.get("provider")
        if provider and provider not in entry["providers"]:
            entry["providers"].append(provider)

    counts = persisted[0] if persisted else {}
    payload_stats = payload.get("stats") or {}

    return {
        "execution": execution_summary(execution),
        "stats": {
            "records_extracted": payload_stats.get("records_extracted", len(extracted)),
            "products": len(products),
            "products_collapsed": payload_stats.get("products_collapsed", 0),
            "distinct_profiles": payload_stats.get("distinct_signatures"),
            "sources_failed": len(failures),
            "products_total": counts.get("products_total"),
            "products_new": counts.get("products_new"),
            "products_updated": counts.get("products_updated"),
            "products_deactivated": counts.get("products_deactivated"),
            "runs_logged": counts.get("runs_logged"),
        },
        "collapsed": payload.get("collapsed") or [],
        "sources": list(by_source.values()),
        "failures": failures,
        "products": products,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workflow", default=WORKFLOW_NAME, help="workflow to trigger")
    parser.add_argument(
        "--node", default=TRIGGER_NODE, help="node the manual execution starts from"
    )
    parser.add_argument(
        "--source", default=None, help="only report products of this source id"
    )
    parser.add_argument(
        "--wait", type=float, default=180.0, help="seconds to wait for the execution"
    )
    parser.add_argument("--out", default=None, help="write the JSON report to a file")
    parser.add_argument(
        "--snapshot-dir",
        default=str(DEFAULT_SNAPSHOT_DIR),
        help="directory the per-source JSON snapshots are written to",
    )
    parser.add_argument(
        "--no-snapshot",
        action="store_true",
        help="do not write the per-source JSON snapshots",
    )
    parser.add_argument(
        "--quiet", action="store_true", help="print only the JSON document"
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(levelname)s %(message)s",
    )
    logger = logging.getLogger("crawl")

    settings = get_settings()
    admin = N8nAdmin(settings.n8n.api_url)
    try:
        admin.login(
            os.environ.get("N8N_OWNER_EMAIL", ""),
            os.environ.get("N8N_OWNER_PASSWORD", ""),
        )
        workflow = find_workflow(admin, args.workflow)
        workflow_id = str(workflow["id"])
        previous = latest_execution_id(admin, workflow_id)

        logger.info("triggering '%s' on n8n", args.workflow)
        admin.run_workflow(workflow_id, args.node)
        execution = wait_for_execution(admin, workflow_id, previous, args.wait)
    except N8nError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    report = build_report(execution, args.source)
    document = json.dumps(report, indent=2, ensure_ascii=False, default=str)

    if args.out:
        Path(args.out).write_text(document + "\n", encoding="utf-8")
        logger.info("report written to %s", args.out)

    # One JSON document per crawled source, next to the PostgreSQL catalogue.
    if not args.no_snapshot:
        written = write_snapshots(
            report["products"],
            output_dir=Path(args.snapshot_dir),
            generated_at=report["execution"].get("started_at"),
        )
        report["snapshots"] = [str(path) for path in written]
        document = json.dumps(report, indent=2, ensure_ascii=False, default=str)
        if args.out:
            Path(args.out).write_text(document + "\n", encoding="utf-8")

    print(document)

    status = report["execution"].get("status")
    return 0 if status == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
