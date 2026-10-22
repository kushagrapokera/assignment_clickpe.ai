#!/usr/bin/env python3
"""Check that a credential works by calling a real endpoint.

Creates a throw away workflow that calls the Ollama API with the configured
credential, runs it and reports what happened.
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

CREDENTIAL_TYPE = os.environ.get("CHECK_CREDENTIAL_TYPE", "httpBearerAuth")
CREDENTIAL_NAME = os.environ.get("CHECK_CREDENTIAL_NAME", "Ollama API")


def main() -> int:
    settings = get_settings()
    admin = N8nAdmin(settings.n8n.api_url)
    admin.login(
        os.environ.get("N8N_OWNER_EMAIL", ""),
        os.environ.get("N8N_OWNER_PASSWORD", ""),
    )

    if CREDENTIAL_TYPE == "httpBearerAuth":
        data = {"token": settings.llm.api_key}
    else:
        data = {"name": "Authorization", "value": f"Bearer {settings.llm.api_key}"}
    print(f"credential type: {CREDENTIAL_TYPE}")

    credential = admin.create_credential(CREDENTIAL_NAME, CREDENTIAL_TYPE, data)
    credential_id = credential["id"]

    client = N8nClient(settings.n8n.api_url, settings.n8n.api_key)
    workflow = {
        "name": "zz credential test",
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
                "parameters": {
                    "method": "POST",
                    "url": "https://ollama.com/v1/chat/completions",
                    "sendBody": True,
                    "specifyBody": "json",
                    "jsonBody": (
                        "={{ JSON.stringify({model: 'gemma4:31b', messages: "
                        "[{role: 'user', content: 'say OK'}], max_tokens: 8}) }}"
                    ),
                    "authentication": "predefinedCredentialType",
                    "nodeCredentialType": CREDENTIAL_TYPE,
                    "options": {},
                },
                "id": "t2",
                "name": "Call",
                "type": "n8n-nodes-base.httpRequest",
                "typeVersion": 4.2,
                "position": [200, 0],
                "credentials": {
                    CREDENTIAL_TYPE: {"id": credential_id, "name": CREDENTIAL_NAME}
                },
            },
        ],
        "connections": {
            "When": {"main": [[{"node": "Call", "type": "main", "index": 0}]]}
        },
        "settings": {},
    }

    workflow_id = client.create_workflow(workflow)["id"]
    try:
        admin.run_workflow(workflow_id, "When")
        time.sleep(12)
        execution = None
        for item in admin.list_executions(limit=25):
            if item.get("workflowId") == workflow_id:
                execution = item
                break
        if execution is None:
            print("the test workflow did not run")
            return 1
        data = decode_execution_data(
            admin.execution(str(execution["id"])).get("data")
        )
        failed = False
        for node, runs in (data.get("resultData") or {}).get("runData", {}).items():
            for run in runs:
                if not isinstance(run, dict):
                    continue
                error = run.get("error")
                if error:
                    failed = True
                    print(f"ERROR in {node}:", flush=True)
                    print(json.dumps(error, indent=1, default=str)[:2000], flush=True)
                for branch in (run.get("data") or {}).get("main") or []:
                    if isinstance(branch, list) and branch:
                        print(f"{node}: {str(branch[0].get('json'))[:220]}", flush=True)
        return 1 if failed else 0
    finally:
        client.delete_workflow(workflow_id)
        for item in admin.list_credentials():
            if item["id"] == credential_id:
                admin.delete_credential(credential_id)


if __name__ == "__main__":
    raise SystemExit(main())
