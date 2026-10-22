#!/usr/bin/env python3
"""Run the LLM node of the matching workflow on its own.

The node is copied out of the running workflow, so the test uses exactly the
same parameters, credential and body as the real run.
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, str(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from app.config import get_settings  # noqa: E402
from app.n8n.admin import N8nAdmin  # noqa: E402
from app.n8n.client import N8nClient  # noqa: E402
from app.n8n.execution import decode_execution_data  # noqa: E402

WORKFLOW_ID = os.environ.get("WORKFLOW_ID", "2mGTgbVsT4YS25rH")


def main() -> int:
    settings = get_settings()
    client = N8nClient(settings.n8n.api_url, settings.n8n.api_key)
    workflow = client.get_workflow(WORKFLOW_ID)
    node = next(n for n in workflow["nodes"] if n["name"] == "LLM Qualitative Check")

    admin = N8nAdmin(settings.n8n.api_url)
    admin.login(
        os.environ.get("N8N_OWNER_EMAIL", ""),
        os.environ.get("N8N_OWNER_PASSWORD", ""),
    )

    body = {
        "model": settings.llm.model,
        "messages": [{"role": "user", "content": "say OK"}],
        "max_tokens": 8,
    }
    test = {
        "name": "zz llm node test",
        "nodes": [
            {
                "parameters": {},
                "id": "t1",
                "name": "When",
                "type": "n8n-nodes-base.manualTrigger",
                "typeVersion": 1,
                "position": [0, 0],
            },
            {
                "parameters": dict(
                    node["parameters"],
                    url=node["parameters"]["url"],
                    jsonBody="={{ $json.body_json }}",
                ),
                "id": "t2",
                "name": "Call",
                "type": node["type"],
                "typeVersion": node["typeVersion"],
                "position": [200, 0],
                "credentials": node.get("credentials"),
            },
            {
                "parameters": {
                    "jsCode": "return [{ json: { body_json: JSON.stringify($json.body) } }];"
                },
                "id": "t3",
                "name": "Prepare",
                "type": "n8n-nodes-base.code",
                "typeVersion": 2,
                "position": [-200, 0],
            },
        ],
        "connections": {
            "When": {"main": [[{"node": "Prepare", "type": "main", "index": 0}]]},
            "Prepare": {"main": [[{"node": "Call", "type": "main", "index": 0}]]},
        },
        "settings": {},
    }
    # the manual trigger runs first, so the body is prepared by a code node
    test["connections"]["When"] = {
        "main": [[{"node": "Prepare", "type": "main", "index": 0}]]
    }
    test["nodes"][2]["parameters"]["jsCode"] = (
        "return [{ json: { body_json: "
        + json.dumps(json.dumps(body))
        + " } }];"
    )

    workflow_id = client.create_workflow(test)["id"]
    print(f"test workflow: {workflow_id}")
    admin.run_workflow(workflow_id, "When")
    time.sleep(14)

    execution = None
    for item in admin.list_executions(limit=25):
        if item.get("workflowId") == workflow_id:
            execution = item
            break
    if execution is None:
        print("no execution found")
        return 1

    data = decode_execution_data(admin.execution(str(execution["id"])).get("data"))
    for node, runs in (data.get("resultData") or {}).get("runData", {}).items():
        for run in runs:
            if not isinstance(run, dict):
                continue
            if run.get("error"):
                error = run["error"]
                print(f"ERROR in {node}: {str(error.get('message'))[:200]}")
                print(f"  {str(error.get('description'))[:200]}")
            for branch in (run.get("data") or {}).get("main") or []:
                if isinstance(branch, list) and branch:
                    print(f"{node}: {str(branch[0].get('json'))[:240]}")
    client.delete_workflow(workflow_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
