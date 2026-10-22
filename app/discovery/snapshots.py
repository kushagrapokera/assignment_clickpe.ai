"""Persisting the discovery results.

The crawl itself is executed by n8n and the authoritative copy of the product
catalogue lives in PostgreSQL.  This module writes an additional, human
readable snapshot of every crawl: one JSON document per crawled source, plus
an index that ties them together.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_SNAPSHOT_DIR = Path("data") / "discovery"


def _slug(value: str) -> str:
    """Turn a publisher name into a file name friendly slug."""
    slug = "".join(
        character if character.isalnum() else "-" for character in str(value).lower()
    )
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-")


def build_snapshots(products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group the extracted products into one snapshot document per publisher.

    The catalogue is grouped by the publisher that was crawled - BankBazaar
    and Bajaj Finserv - so every bank ends up in exactly one file, even when
    it publishes several pages.

    :param products: extracted products as returned by the crawl
    :return: one snapshot document per publisher
    """
    grouped: dict[str, dict[str, Any]] = {}

    for product in products or []:
        publisher = str(
            product.get("source_publisher") or product.get("source_id") or "unknown"
        )
        snapshot = grouped.setdefault(
            publisher,
            {
                "publisher": publisher,
                "publisher_id": product.get("source_publisher_id"),
                "sources": [],
                "providers": [],
                "products": [],
            },
        )
        source_id = product.get("source_id")
        if source_id and source_id not in snapshot["sources"]:
            snapshot["sources"].append(source_id)
        # A canonical product can stand for several crawled pages; those
        # pages belong to the publisher as well.
        for variant in product.get("variants") or []:
            variant_source = variant.get("source_id")
            if variant_source and variant_source not in snapshot["sources"]:
                snapshot["sources"].append(variant_source)
        provider = product.get("provider")
        if provider and provider not in snapshot["providers"]:
            snapshot["providers"].append(provider)
        snapshot["products"].append(product)

    snapshots = []
    for snapshot in grouped.values():
        snapshot["sources"].sort()
        snapshot["providers"].sort()
        snapshot["product_count"] = len(snapshot["products"])
        snapshot["source_count"] = len(snapshot["sources"])
        snapshot["products"].sort(
            key=lambda item: (str(item.get("source_id")), str(item.get("provider")))
        )
        snapshots.append(snapshot)
    snapshots.sort(key=lambda item: item["publisher"])
    return snapshots


def write_snapshots(
    products: list[dict[str, Any]],
    output_dir: Path | str = DEFAULT_SNAPSHOT_DIR,
    generated_at: str | None = None,
) -> list[Path]:
    """Write one JSON file per publisher and an index file.

    The files are written atomically so a reader never sees a half written
    document.

    :param products: extracted products as returned by the crawl
    :param output_dir: directory the snapshots are written to
    :param generated_at: ISO timestamp of the crawl
    :return: the paths of the written files
    """
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    stamp = generated_at or datetime.now(timezone.utc).isoformat()

    written: list[Path] = []
    index_entries: list[dict[str, Any]] = []

    for snapshot in build_snapshots(products):
        document = dict(snapshot)
        document["generated_at"] = stamp
        path = directory / f"{_slug(snapshot['publisher'])}.json"
        _write_json(path, document)
        written.append(path)
        index_entries.append(
            {
                "publisher": snapshot["publisher"],
                "publisher_id": snapshot["publisher_id"],
                "file": path.name,
                "source_count": snapshot["source_count"],
                "product_count": snapshot["product_count"],
                "sources": snapshot["sources"],
                "providers": snapshot["providers"],
            }
        )
        logger.info(
            "snapshot written: %s (%s sources, %s products)",
            path,
            snapshot["source_count"],
            snapshot["product_count"],
        )

    index_path = directory / "index.json"
    _write_json(
        index_path,
        {
            "generated_at": stamp,
            "snapshot_count": len(index_entries),
            "product_count": sum(entry["product_count"] for entry in index_entries),
            "snapshots": index_entries,
        },
    )
    written.append(index_path)
    return written


def _write_json(path: Path, document: dict[str, Any]) -> None:
    """Write a JSON document atomically."""
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(document, indent=2, ensure_ascii=False, default=str) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)
