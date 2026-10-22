"""Client for the n8n public REST API.

The same client is used to push workflows into the instance and to trigger
them from the ingestion service.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)


class N8nError(RuntimeError):
    """Raised when the n8n API returns an error response."""


class N8nClient:
    """Minimal, dependency free client for the n8n public API."""

    def __init__(self, api_url: str, api_key: str, timeout: int = 30) -> None:
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    # -- transport -----------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        query: dict[str, str] | None = None,
    ) -> Any:
        """Send a request to the n8n API and decode the JSON response."""
        url = f"{self.api_url}/api/v1{path}"
        if query:
            pairs = "&".join(f"{key}={value}" for key, value in query.items())
            url = f"{url}?{pairs}"
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "X-N8N-API-KEY": self.api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise N8nError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:  # pragma: no cover - network path
            raise N8nError(f"{method} {path} -> {exc.reason}") from exc
        if not raw.strip():
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    # -- workflows -----------------------------------------------------------

    def list_workflows(self) -> list[dict[str, Any]]:
        """Return every workflow of the instance."""
        result = self._request("GET", "/workflows", query={"limit": "100"}) or {}
        return result.get("data", []) if isinstance(result, dict) else []

    def get_workflow(self, workflow_id: str) -> dict[str, Any] | None:
        """Return a single workflow.

        The endpoint answers with the workflow at the top level, the list
        endpoint nests it under ``data``.
        """
        result = self._request("GET", f"/workflows/{workflow_id}")
        if not isinstance(result, dict):
            return None
        if "nodes" in result:
            return result
        data = result.get("data")
        return data if isinstance(data, dict) else None

    def create_workflow(self, workflow: dict[str, Any]) -> dict[str, Any]:
        """Create a workflow and return the created resource."""
        result = self._request("POST", "/workflows", workflow)
        return result.get("data", result) if isinstance(result, dict) else {}

    def update_workflow(self, workflow_id: str, workflow: dict[str, Any]) -> dict[str, Any]:
        """Update an existing workflow."""
        result = self._request("PUT", f"/workflows/{workflow_id}", workflow)
        return result.get("data", result) if isinstance(result, dict) else {}

    def delete_workflow(self, workflow_id: str) -> None:
        """Delete a workflow."""
        self._request("DELETE", f"/workflows/{workflow_id}")

    def activate_workflow(self, workflow_id: str) -> dict[str, Any]:
        """Activate a workflow so its triggers start firing."""
        result = self._request("POST", f"/workflows/{workflow_id}/activate")
        return result.get("data", result) if isinstance(result, dict) else {}

    def deactivate_workflow(self, workflow_id: str) -> dict[str, Any]:
        """Deactivate a workflow."""
        result = self._request("POST", f"/workflows/{workflow_id}/deactivate")
        return result.get("data", result) if isinstance(result, dict) else {}

    # -- credentials ---------------------------------------------------------

    def list_credentials(self) -> list[dict[str, Any]]:
        """Return every credential of the instance."""
        result = self._request("GET", "/credentials") or {}
        return result.get("data", []) if isinstance(result, dict) else []

    def create_credential(
        self, name: str, credential_type: str, data: dict[str, Any]
    ) -> dict[str, Any]:
        """Create a credential and return the created resource."""
        result = self._request(
            "POST",
            "/credentials",
            {"name": name, "type": credential_type, "data": data},
        )
        return result.get("data", result) if isinstance(result, dict) else {}

    def delete_credential(self, credential_id: str) -> None:
        """Delete a credential."""
        self._request("DELETE", f"/credentials/{credential_id}")
