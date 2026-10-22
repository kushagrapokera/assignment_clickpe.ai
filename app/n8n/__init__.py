"""Integration with the self-hosted n8n instance."""

from __future__ import annotations

from .client import N8nClient, N8nError

__all__ = ["N8nClient", "N8nError"]
