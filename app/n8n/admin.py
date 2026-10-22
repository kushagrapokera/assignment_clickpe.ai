"""Session based administration client for n8n.

The public REST API (``/api/v1``) covers workflows and credentials, but a few
operations - creating the owner account, minting API keys and triggering a
workflow manually - are only available on the internal API (``/rest``) that
the n8n UI itself uses.  This module implements both halves.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from typing import Any

from .client import N8nError


class N8nAdmin:
    """Admin client that authenticates with the owner account."""

    def __init__(self, base_url: str, timeout: int = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._jar = CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar)
        )

    # -- transport -----------------------------------------------------------

    def request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> Any:
        """Perform a JSON request against the internal API."""
        url = f"{self.base_url}{path}"
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
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

    def _relax_cookie_security(self) -> None:
        """Allow the session cookie to travel over plain HTTP.

        n8n marks the session cookie ``Secure`` even on plain HTTP
        installations.  Python's cookie jar then refuses to send it back,
        which breaks every session authenticated call.
        """
        for cookie in self._jar:
            if cookie.secure:
                cookie.secure = False

    # -- session -------------------------------------------------------------

    def login(self, email: str, password: str) -> None:
        """Authenticate and keep the session cookie for later requests."""
        result = self.request(
            "POST",
            "/rest/login",
            {"emailOrLdapLoginId": email, "email": email, "password": password},
        )
        if isinstance(result, dict) and result.get("data", {}).get("email"):
            self._relax_cookie_security()
            return
        raise N8nError(f"login failed: {result}")

    def ensure_owner(self, email: str, password: str) -> bool:
        """Create the owner account when the instance has not been set up yet."""
        settings = self.request("GET", "/rest/settings") or {}
        data = settings.get("data", {}) if isinstance(settings, dict) else {}
        needs_setup = bool(data.get("userManagement", {}).get("showSetupOnFirstLoad"))
        if not needs_setup:
            return False
        try:
            self.request(
                "POST",
                "/rest/owner/setup",
                {
                    "email": email,
                    "firstName": "Loan",
                    "lastName": "Engine",
                    "password": password,
                },
            )
            return True
        except N8nError as exc:
            if "already" in str(exc).lower():
                return False
            raise

    # -- workflows -----------------------------------------------------------

    def list_workflows(self) -> list[dict[str, Any]]:
        """Return every workflow with its id and active state."""
        result = self.request("GET", "/rest/workflows") or {}
        workflows = result.get("data", []) if isinstance(result, dict) else []
        return workflows

    def run_workflow(self, workflow_id: str, trigger_node: str = "Schedule Trigger") -> Any:
        """Trigger a workflow manually, starting at ``trigger_node``."""
        result = self.request(
            "POST",
            f"/rest/workflows/{workflow_id}/run",
            {"triggerToStartFrom": {"name": trigger_node}},
        )
        return result

    def list_executions(self, limit: int = 10) -> list[dict[str, Any]]:
        """Return the most recent executions."""
        result = self.request("GET", f"/rest/executions?limit={limit}") or {}
        data = result.get("data", {}) if isinstance(result, dict) else {}
        return data.get("results", []) if isinstance(data, dict) else []

    def execution(self, execution_id: str, include_data: bool = True) -> dict[str, Any]:
        """Return one execution with its node results."""
        result = self.request(
            "GET", f"/rest/executions/{execution_id}?includeData={str(include_data).lower()}"
        )
        return result.get("data", {}) if isinstance(result, dict) else {}

    # -- credentials ---------------------------------------------------------

    def list_credentials(self) -> list[dict[str, Any]]:
        """Return every credential of the instance."""
        result = self.request("GET", "/rest/credentials") or {}
        data = result.get("data", []) if isinstance(result, dict) else []
        return data

    def create_credential(
        self, name: str, credential_type: str, data: dict[str, Any]
    ) -> dict[str, Any]:
        """Create a credential and return the created resource."""
        result = self.request(
            "POST",
            "/rest/credentials",
            {"name": name, "type": credential_type, "data": data},
        )
        return result.get("data", result) if isinstance(result, dict) else {}

    def delete_credential(self, credential_id: str) -> None:
        """Delete a credential."""
        self.request("DELETE", f"/rest/credentials/{credential_id}")

    # -- api keys ------------------------------------------------------------

    def valid_scopes(self) -> list[str]:
        """Return the API key scopes the owner role may request."""
        result = self.request("GET", "/rest/api-keys/scopes") or {}
        scopes = result.get("data") if isinstance(result, dict) else None
        if not isinstance(scopes, list) or not scopes:
            raise N8nError(f"could not read API key scopes: {result}")
        return scopes

    def delete_api_keys(self, label: str) -> int:
        """Remove every API key with the given label and return the count."""
        result = self.request("GET", "/rest/api-keys") or {}
        items = result.get("data", {}).get("items", []) if isinstance(result, dict) else []
        removed = 0
        for item in items:
            if item.get("label") == label:
                self.request("DELETE", f"/rest/api-keys/{item['id']}")
                removed += 1
        return removed

    def create_api_key(self, label: str, scopes: list[str], ttl_days: int = 365) -> str:
        """Create an API key and return the raw secret."""
        import time

        expires_at_ms = int((time.time() + ttl_days * 24 * 3600) * 1000)
        result = self.request(
            "POST",
            "/rest/api-keys",
            {"label": label, "expiresAt": expires_at_ms, "scopes": scopes},
        )
        key = ""
        if isinstance(result, dict):
            key = result.get("rawApiKey") or result.get("data", {}).get("rawApiKey", "")
        if not key:
            raise N8nError(f"could not mint API key: {result}")
        return key
