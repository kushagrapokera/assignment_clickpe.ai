#!/usr/bin/env python3
"""Upload an applicant file through the HTTP interface of the engine.

Usage::

    python3 scripts/upload.py samples/users.csv
    python3 scripts/upload.py samples/users.csv --wait
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402

API_URL = os.environ.get("API_URL", "http://127.0.0.1:8000")


def upload(path: Path) -> dict:
    """Send a file to the upload endpoint."""
    boundary = f"----loanengine{uuid.uuid4().hex}"
    content_type = mimetypes.guess_type(path.name)[0] or "text/csv"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8") + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode("utf-8")

    request = urllib.request.Request(
        f"{API_URL}/api/uploads",
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for(upload_id: str, timeout: float = 900.0) -> dict:
    """Wait until the worker and the matching are done."""
    deadline = time.time() + timeout
    answer: dict = {}
    while time.time() < deadline:
        with urllib.request.urlopen(
            f"{API_URL}/api/uploads/{upload_id}", timeout=30
        ) as response:
            answer = json.loads(response.read().decode("utf-8"))
        batches = answer.get("batches") or []
        if batches and all(batch["matches"] > 0 for batch in batches):
            return answer
        time.sleep(5.0)
    return answer


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", help="path of the applicant file")
    parser.add_argument(
        "--wait", action="store_true", help="wait until the pipeline is done"
    )
    args = parser.parse_args()

    settings = get_settings()
    path = Path(args.csv)
    answer = upload(path)
    print(json.dumps(answer, indent=2))
    print(f"\nuploaded: {answer['upload_id']}")

    if args.wait:
        result = wait_for(answer["upload_id"])
        upload_state = result.get("upload", {})
        batches = result.get("batches") or []
        print(
            json.dumps(
                {
                    "status": upload_state.get("status"),
                    "rows": upload_state.get("total_rows"),
                    "loaded": upload_state.get("accepted_rows"),
                    "rejected": upload_state.get("rejected_rows"),
                    "batches": len(batches),
                    "matches": sum(batch["matches"] for batch in batches),
                    "notifications": sum(batch["notifications"] for batch in batches),
                },
                indent=2,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
