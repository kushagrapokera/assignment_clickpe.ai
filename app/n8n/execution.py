"""Helpers to read the result of an n8n execution.

n8n stores execution data in the "flatted" format: a JSON array that acts as
a string table where every string is an index into that array.  These helpers
decode the payload and pull out the interesting parts.
"""

from __future__ import annotations

from typing import Any


def decode_flatted(values: list) -> Any:
    """Decode a flatted payload into plain Python structures.

    The flatted format stores every string as an index into the payload
    array, which means the structure can contain cycles (n8n links items back
    to their parent).  Containers are therefore registered before they are
    filled, so a cycle resolves to the already created object.

    :param values: the parsed JSON array of the flatted payload
    :return: the decoded structure
    """
    cache: dict[int, Any] = {}

    def resolve(index: int) -> Any:
        if index in cache:
            return cache[index]
        value = values[index]

        if isinstance(value, str):
            if value.isdigit() and int(value) < len(values):
                result: Any = resolve(int(value))
            else:
                result = value
        elif isinstance(value, list):
            container: list = []
            cache[index] = container
            for item in value:
                if isinstance(item, str) and item.isdigit() and int(item) < len(values):
                    container.append(resolve(int(item)))
                else:
                    container.append(item)
            return container
        elif isinstance(value, dict):
            mapping: dict[str, Any] = {}
            cache[index] = mapping
            for key, item in value.items():
                if isinstance(item, str) and item.isdigit() and int(item) < len(values):
                    mapping[key] = resolve(int(item))
                else:
                    mapping[key] = item
            return mapping
        else:
            result = value

        cache[index] = result
        return result

    return resolve(0)


def decode_execution_data(data: Any) -> Any:
    """Decode the ``data`` field of an execution, whatever shape it has."""
    if isinstance(data, str):
        import json

        try:
            data = json.loads(data)
        except json.JSONDecodeError:
            return {}
    if isinstance(data, list):
        return decode_flatted(data)
    return data or {}


def node_output(execution: dict[str, Any], node_name: str) -> list[dict[str, Any]]:
    """Return the JSON payloads a node produced during an execution."""
    result_data = execution.get("resultData") or {}
    run_data = result_data.get("runData") or {}
    for run in run_data.get(node_name, []):
        outputs = (run.get("data") or {}).get("main") or []
        payloads: list[dict[str, Any]] = []
        for branch in outputs:
            for item in branch or []:
                payload = item.get("json", item)
                payloads.append(payload)
        if payloads:
            return payloads
    return []


def execution_summary(execution: dict[str, Any]) -> dict[str, Any]:
    """Return the interesting metadata of an execution."""
    return {
        "id": execution.get("id"),
        "status": execution.get("status"),
        "mode": execution.get("mode"),
        "started_at": execution.get("startedAt"),
        "stopped_at": execution.get("stoppedAt"),
        "workflow_id": execution.get("workflowId"),
    }
