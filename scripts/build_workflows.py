#!/usr/bin/env python3
"""Build the importable n8n workflow files.

The workflow *templates* in ``n8n/templates`` describe the node graph and use
``__BUNDLE__:<module>`` placeholders wherever a Code node needs logic.  This
script resolves every placeholder into a self contained script (the modules in
``n8n/code`` are bundled by :mod:`jsbundler`) and writes the result to
``n8n/workflows``.

Usage::

    python3 scripts/build_workflows.py            # build every workflow
    python3 scripts/build_workflows.py --check    # verify the build is current
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from jsbundler import Bundler  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CODE_ROOT = PROJECT_ROOT / "n8n" / "code"
TEMPLATE_DIR = PROJECT_ROOT / "n8n" / "templates"
OUTPUT_DIR = PROJECT_ROOT / "n8n" / "workflows"
SOURCES_FILE = PROJECT_ROOT / "n8n" / "sources" / "sources.json"
SCHEDULES_FILE = PROJECT_ROOT / "n8n" / "config" / "schedules.json"

logger = logging.getLogger("build_workflows")

BUNDLE_MARKER = re.compile(r"^__BUNDLE__:(?P<module>[A-Za-z0-9_./-]+)$")
CRON_MARKER = re.compile(r"^__CRON__:(?P<name>[A-Za-z0-9_-]+)$")
NODE_MARKER = re.compile(r"__NODE__:(?P<name>[A-Za-z0-9_-]+)")
VIRTUAL_SOURCES = "virtual:sources.json"
VIRTUAL_CONFIG = "virtual:config.json"

HEADER = (
    "// ---------------------------------------------------------\n"
    "// Bundled by scripts/build_workflows.py - do not edit here.\n"
    "// Edit the modules in n8n/code and rebuild.\n"
    "// ---------------------------------------------------------\n"
)


def _walk(node: Any, replacements: dict[str, str]) -> Any:
    """Recursively replace bundle markers inside a JSON structure."""
    if isinstance(node, dict):
        return {key: _walk(value, replacements) for key, value in node.items()}
    if isinstance(node, list):
        return [_walk(value, replacements) for value in node]
    if isinstance(node, str):
        match = BUNDLE_MARKER.match(node)
        if match:
            return replacements[match.group("module")]
    return node


def check_graph(nodes: list[dict], connections: dict, label: str) -> None:
    """Fail the build when the node graph is not connected.

    A missing connection in a long workflow is easy to introduce and hard to
    spot, because n8n only complains at runtime with a rather cryptic
    message.  Every node must be reachable from a trigger and every node
    must lead somewhere.
    """
    names = {node["name"] for node in nodes}
    incoming: dict[str, list[str]] = {name: [] for name in names}
    outgoing: dict[str, list[str]] = {name: [] for name in names}
    for source, spec in connections.items():
        if source not in names:
            raise SystemExit(f"{label}: connection from unknown node '{source}'")
        for branch in spec.get("main", []):
            for connection in branch or []:
                target = connection.get("node")
                if target not in names:
                    raise SystemExit(
                        f"{label}: connection to unknown node '{target}'"
                    )
                incoming[target].append(source)
                outgoing[source].append(target)

    triggers = [
        node["name"]
        for node in nodes
        if "trigger" in str(node.get("type", "")).lower()
        or node.get("type", "").endswith("webhook")
    ]
    if not triggers:
        raise SystemExit(f"{label}: the workflow has no trigger")

    def reachable(start: str) -> set[str]:
        seen: set[str] = set()
        stack = [start]
        while stack:
            current = stack.pop()
            for target in outgoing.get(current, []):
                if target not in seen:
                    seen.add(target)
                    stack.append(target)
        return seen

    covered = set()
    for trigger in triggers:
        covered |= reachable(trigger)

    # A trigger is reachable by definition, it starts the execution.
    orphans = sorted(names - covered - set(triggers))
    if orphans:
        raise SystemExit(
            f"{label}: these nodes are not reachable from a trigger: {', '.join(orphans)}"
        )

    dead_ends = sorted(
        name
        for name in names
        if name not in triggers and not outgoing.get(name) and not incoming.get(name)
    )
    if dead_ends:
        raise SystemExit(
            f"{label}: these nodes do not lead anywhere: {', '.join(dead_ends)}"
        )


def check_syntax(script: str, label: str) -> None:
    """Fail the build when the bundled script is not valid JavaScript.

    The n8n Code node would only report the problem at runtime, which is far
    too late, so the bundle is parsed here with the same engine that runs it.
    """
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as handle:
        handle.write(script)
        temporary = handle.name
    try:
        result = subprocess.run(
            ["node", "--check", temporary],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise SystemExit(
                f"syntax error in {label}:\n{result.stderr.strip()}"
            )
    except FileNotFoundError:  # pragma: no cover - node is optional
        logger.warning("node is not available, skipping the syntax check")
    finally:
        Path(temporary).unlink(missing_ok=True)


def build_workflow(
    template_path: Path, bundler: Bundler, schedules: dict[str, str]
) -> str:
    """Return the JSON text of a built workflow."""
    template = json.loads(template_path.read_text(encoding="utf-8"))
    node_refs = (template.get("meta") or {}).get("node_refs") or {}
    markers: set[str] = set()

    def collect(node: Any) -> None:
        if isinstance(node, dict):
            for value in node.values():
                collect(value)
        elif isinstance(node, list):
            for value in node:
                collect(value)
        elif isinstance(node, str):
            match = BUNDLE_MARKER.match(node)
            if match:
                markers.add(match.group("module"))

    collect(template)

    replacements: dict[str, str] = {}
    for module in sorted(markers):
        entry = (CODE_ROOT / module).resolve()
        if not entry.is_file():
            raise SystemExit(f"template {template_path.name}: missing module {module}")
        bundle = bundler.bundle(entry)
        script = (
            f"{HEADER}const __bundle = {bundle.code}\n"
            f"return __bundle.run($input.all());\n"
        )
        check_syntax(script, f"{template_path.name}:{module}")
        replacements[module] = script

    def substitute(node: Any) -> Any:
        """Replace bundle, cron and node markers with their concrete values."""
        if isinstance(node, dict):
            return {key: substitute(value) for key, value in node.items()}
        if isinstance(node, list):
            return [substitute(value) for value in node]
        if isinstance(node, str):
            cron = CRON_MARKER.match(node)
            if cron:
                name = cron.group("name")
                if name not in schedules:
                    raise SystemExit(
                        f"template {template_path.name}: unknown schedule '{name}'"
                    )
                return schedules[name]
            # The node markers are embedded in the source of a Code node,
            # so they are replaced wherever they appear.
            if NODE_MARKER.search(node):
                for key, value in node_refs.items():
                    node = node.replace(f"__NODE__:{key}", value)
                leftover = NODE_MARKER.search(node)
                if leftover:
                    raise SystemExit(
                        f"template {template_path.name}: unknown node reference "
                        f"'{leftover.group('name')}'"
                    )
                return node
        return node

    built = substitute(_walk(template, replacements))
    check_graph(built.get("nodes", []), built.get("connections", {}), template_path.name)
    built["meta"] = dict(built.get("meta") or {})
    built["meta"]["template"] = template_path.name
    built["meta"]["bundled_modules"] = sorted(markers)
    return json.dumps(built, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail when the committed workflow files are out of date",
    )
    parser.add_argument(
        "--profile",
        default="test",
        choices=["test", "prod"],
        help="schedule profile to bake into the workflows (default: test)",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    if not TEMPLATE_DIR.exists():
        print("no templates found", file=sys.stderr)
        return 1

    sources = json.loads(SOURCES_FILE.read_text(encoding="utf-8"))
    schedule_config = json.loads(SCHEDULES_FILE.read_text(encoding="utf-8"))
    settings = get_settings()
    # Only non secret values are injected: the API key itself stays in the
    # credential store of n8n.
    config = {
        "llm": {
            "model": settings.llm.model,
            "base_url": settings.llm.base_url,
        },
        "notification": {
            "from_email": settings.notification.from_email,
            "max_emails": int(
                os.environ.get("NOTIFICATION_MAX_EMAILS_PER_RUN", "5")
            ),
        },
    }
    profiles = schedule_config.get("profiles", {})
    if args.profile not in profiles:
        print(f"unknown schedule profile: {args.profile}", file=sys.stderr)
        return 1
    schedules = profiles[args.profile]
    bundler = Bundler(
        CODE_ROOT,
        virtual_modules={VIRTUAL_SOURCES: sources, VIRTUAL_CONFIG: config},
    )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    stale: list[str] = []

    for template_path in sorted(TEMPLATE_DIR.glob("*.json")):
        built = build_workflow(template_path, bundler, schedules)
        output_path = OUTPUT_DIR / template_path.name
        current = output_path.read_text(encoding="utf-8") if output_path.exists() else ""
        if current == built:
            print(f"up to date  {output_path.name}")
            continue
        if args.check:
            stale.append(output_path.name)
            print(f"stale       {output_path.name}")
            continue
        output_path.write_text(built, encoding="utf-8")
        print(f"built       {output_path.name} (profile: {args.profile})")

    if stale:
        print(
            "\nworkflow files are out of date, run: python3 scripts/build_workflows.py",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
