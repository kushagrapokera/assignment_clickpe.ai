#!/usr/bin/env python3
"""A tiny CommonJS bundler for the n8n Code node.

The n8n Code node runs inside a sandbox that cannot ``require`` files from
disk, so every Code node has to be a single self contained script.  Keeping
the logic in real modules under ``n8n/code`` and bundling them at build time
gives both properties: readable, testable modules in git *and* importable
workflow files.

The bundler resolves relative ``require`` calls, wraps every module in a
factory function and emits a tiny runtime that mimics CommonJS.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

# `require('./foo')` / `require('../bar/baz')`
REQUIRE_PATTERN = re.compile(r"""require\(\s*['"](\.[^'"]+)['"]\s*\)""")

RUNTIME_TEMPLATE = """\
// ---------------------------------------------------------------------------
// Auto-generated bundle. Source of truth: {entry}
// Regenerate with: python3 scripts/build_workflows.py
// ---------------------------------------------------------------------------
(function () {{
  'use strict';
  const __modules = {{}};
  const __cache = {{}};
  const __virtual = {{}};

  function __dirnameOf(key) {{
    const index = key.lastIndexOf('/');
    return index === -1 ? '' : key.slice(0, index);
  }}

  function __resolve(request, fromKey) {{
    if (!request.startsWith('.')) {{
      return request;
    }}
    const base = __dirnameOf(fromKey);
    const segments = (base ? base.split('/') : []).concat(request.split('/'));
    const stack = [];
    segments.forEach((segment) => {{
      if (segment === '.' || segment === '') {{
        return;
      }}
      if (segment === '..') {{
        stack.pop();
        return;
      }}
      stack.push(segment);
    }});
    return stack.join('/');
  }}

  function __require(request, fromKey) {{
    const key = __resolve(request, fromKey || '');
    if (Object.prototype.hasOwnProperty.call(__virtual, key)) {{
      return __virtual[key];
    }}
    const candidates = [key, key + '.js', key + '/index.js'];
    let resolved = null;
    for (let index = 0; index < candidates.length; index += 1) {{
      if (Object.prototype.hasOwnProperty.call(__modules, candidates[index])) {{
        resolved = candidates[index];
        break;
      }}
    }}
    if (!resolved) {{
      throw new Error('Module not found in bundle: ' + key);
    }}
    if (__cache[resolved]) {{
      return __cache[resolved].exports;
    }}
    const module = {{ exports: {{}} }};
    __cache[resolved] = module;
    const localRequire = (next) => __require(next, resolved);
    __modules[resolved](module, module.exports, localRequire);
    return module.exports;
  }}
{modules}
  const __entry = __require({entry!r});
  return __entry;
}})();
"""


@dataclass
class BundleResult:
    """The generated script plus the list of modules it contains."""

    code: str
    modules: list[str] = field(default_factory=list)


class BundleError(RuntimeError):
    """Raised when a module cannot be resolved or parsed."""


class Bundler:
    """Bundles a directory of CommonJS modules into a single script."""

    def __init__(self, code_root: Path, virtual_modules: dict[str, str] | None = None) -> None:
        self.code_root = code_root.resolve()
        self.virtual_modules = virtual_modules or {}

    # -- helpers -------------------------------------------------------------

    def _module_key(self, path: Path) -> str:
        """Return the bundle key of a module (its path below the code root)."""
        return path.resolve().relative_to(self.code_root).as_posix()

    def _resolve(self, request: str, importer: Path) -> Path:
        """Resolve a relative require to a file on disk."""
        candidate = (importer.parent / request).resolve()
        if candidate.is_file():
            return candidate
        if candidate.with_suffix(".js").is_file():
            return candidate.with_suffix(".js")
        if (candidate / "index.js").is_file():
            return candidate / "index.js"
        raise BundleError(f"cannot resolve '{request}' imported by {importer}")

    # -- public API ----------------------------------------------------------

    def bundle(self, entry: Path) -> BundleResult:
        """Bundle the module graph reachable from ``entry``."""
        entry = entry.resolve()
        modules: dict[str, str] = {}
        order: list[str] = []
        self._collect(entry, modules, order)

        rendered = []
        for key in order:
            body = modules[key].replace("__BUNDLE_KEY__", key)
            rendered.append(
                f"  __modules[{key!r}] = function (module, exports, require) {{\n"
                f"{body}\n"
                f"  }};\n"
            )

        virtual = {}
        for key, value in self.virtual_modules.items():
            virtual[key] = json.dumps(value, indent=2)

        virtual_block = ""
        if virtual:
            entries = ",\n".join(f"    {key!r}: {value}" for key, value in virtual.items())
            virtual_block = f"  Object.assign(__virtual, {{\n{entries}\n  }});\n"

        code = RUNTIME_TEMPLATE.format(
            entry=self._module_key(entry),
            modules="\n".join(rendered),
        )
        if virtual_block:
            code = code.replace("  const __entry =", virtual_block + "  const __entry =", 1)
        return BundleResult(code=code, modules=order)

    # -- internals -----------------------------------------------------------

    def _collect(self, path: Path, modules: dict[str, str], order: list[str]) -> None:
        """Recursively add a module and its dependencies to the bundle."""
        key = self._module_key(path)
        if key in modules:
            return
        source = path.read_text(encoding="utf-8")
        modules[key] = source
        order.append(key)
        for request in REQUIRE_PATTERN.findall(source):
            self._collect(self._resolve(request, path), modules, order)
