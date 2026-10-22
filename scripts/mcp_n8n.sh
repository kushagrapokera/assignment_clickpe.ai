#!/usr/bin/env bash
# Launch the n8n MCP server with credentials loaded from the project .env.
#
# opencode starts MCP servers as plain child processes, so the API key has to
# be present in the environment.  This wrapper loads .env and execs the
# server, which keeps the secret out of opencode.json and out of git.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

export N8N_API_URL="${N8N_API_URL:-http://127.0.0.1:5678}"
export N8N_API_KEY="${N8N_API_KEY:-}"

if [[ -z "${N8N_API_KEY}" ]]; then
  echo "n8n-mcp: N8N_API_KEY is not set - run 'python3 scripts/n8n_bootstrap.py' first" >&2
  exit 1
fi

exec n8n-mcp "$@"
