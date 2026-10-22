#!/usr/bin/env python3
"""Trigger an n8n workflow manually and report the result.

The public API has no "run" endpoint, so the trigger uses the same internal
API the n8n editor uses.  This is the fastest way to exercise a workflow
while developing.

Usage::

    python3 scripts/trigger_workflow.py "Workflow A - Loan Product Discovery"
    python3 scripts/trigger_workflow.py --node "Schedule Trigger"
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.n8n.admin import N8nAdmin  # noqa: E402
from app.n8n.client import N8nError  # noqa: E402

logger = logging.getLogger("trigger_workflow")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workflow", help="workflow name")
    parser.add_argument(
        "--node", default="Schedule Trigger", help="trigger node to start from"
    )
    parser.add_argument(
        "--wait", type=float, default=25.0, help="seconds to wait for the execution"
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    settings = get_settings()

    admin = N8nAdmin(settings.n8n.api_url)
    try:
        admin.login(
            os.environ.get("N8N_OWNER_EMAIL", ""),
            os.environ.get("N8N_OWNER_PASSWORD", ""),
        )
        workflows = {item["name"]: item for item in admin.list_workflows()}
        if args.workflow not in workflows:
            print(
                f"error: workflow '{args.workflow}' not found. Known: "
                f"{', '.join(sorted(workflows))}",
                file=sys.stderr,
            )
            return 1
        workflow_id = workflows[args.workflow]["id"]
        logger.info("triggering %s (%s) at '%s'", args.workflow, workflow_id, args.node)
        admin.run_workflow(workflow_id, args.node)

        deadline = time.time() + args.wait
        while time.time() < deadline:
            executions = admin.list_executions(limit=5)
            for execution in executions:
                if execution.get("workflowId") == workflow_id and execution.get(
                    "status"
                ) in {"success", "error", "crashed", "waiting"}:
                    if execution.get("finished"):
                        logger.info(
                            "execution %s finished with status %s",
                            execution.get("id"),
                            execution.get("status"),
                        )
                        return 0 if execution.get("status") == "success" else 1
            time.sleep(2)
        logger.info("no finished execution observed within %.0fs", args.wait)
        return 0
    except N8nError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
