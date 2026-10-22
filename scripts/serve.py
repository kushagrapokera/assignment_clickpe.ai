#!/usr/bin/env python3
"""Run the HTTP interface of the engine.

Usage::

    python3 scripts/serve.py
    python3 scripts/serve.py --port 9000
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402

logger = logging.getLogger("serve")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=None, help="address to listen on")
    parser.add_argument("--port", type=int, default=None, help="port to listen on")
    parser.add_argument("--reload", action="store_true", help="reload on a change")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    settings = get_settings()
    host = args.host or settings.api_host
    port = args.port or settings.api_port

    import uvicorn

    from app.api.app import app

    logger.info("the upload page is on http://%s:%s", host, port)
    uvicorn.run(
        "app.api.app:app" if args.reload else app,
        host=host,
        port=port,
        reload=args.reload,
        log_level=settings.log_level.lower(),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
