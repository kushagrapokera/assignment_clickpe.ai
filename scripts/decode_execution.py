#!/usr/bin/env python3
"""Print a decoded n8n execution payload.

n8n stores execution data in the "flatted" format; this helper decodes it
and prints the result as plain JSON so the execution can be inspected from
the command line.

Usage::

    python3 scripts/decode_execution.py 12
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.n8n.admin import N8nAdmin  # noqa: E402
from app.n8n.execution import decode_execution_data  # noqa: E402


def _without_cycles(value, seen=None):
    """Return a copy of the structure with circular references removed."""
    if seen is None:
        seen = set()
    if isinstance(value, dict):
        if id(value) in seen:
            return "<circular reference>"
        seen.add(id(value))
        return {key: _without_cycles(item, seen) for key, item in value.items()}
    if isinstance(value, list):
        if id(value) in seen:
            return "<circular reference>"
        seen.add(id(value))
        return [_without_cycles(item, seen) for item in value]
    return value


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    execution_id = sys.argv[1]

    settings = get_settings()
    admin = N8nAdmin(settings.n8n.api_url)
    admin.login(
        os.environ.get("N8N_OWNER_EMAIL", ""),
        os.environ.get("N8N_OWNER_PASSWORD", ""),
    )
    execution = admin.execution(execution_id)
    decoded = decode_execution_data(execution.get("data"))
    print(json.dumps(_without_cycles(decoded), indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
