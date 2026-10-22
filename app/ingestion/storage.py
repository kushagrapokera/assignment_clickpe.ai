"""The object store of the ingestion.

The uploaded file is never kept in memory: it is streamed into the store and
read back by the worker.  Two implementations exist - the local file system
for the development stack and Amazon S3 for the deployment on AWS.  Both
speak the same interface, so the worker does not have to know which one it is
talking to.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import BinaryIO, Protocol

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)


class ObjectStore(Protocol):
    """The interface every object store has to offer."""

    def put(self, key: str, stream: BinaryIO, max_bytes: int | None = None) -> int:
        """Store the content of a stream under a key and return its size."""
        ...

    def open(self, key: str) -> BinaryIO:
        """Open the object of a key for reading."""
        ...

    def exists(self, key: str) -> bool:
        """Return True when the key exists."""
        ...

    def delete(self, key: str) -> None:
        """Remove the object of a key."""
        ...


class LocalObjectStore:
    """A file system based object store.

    The files live under ``LOCAL_STORAGE_ROOT`` in the layout of an object
    store: ``uploads/<batch id>/<file name>``.
    """

    def __init__(self, root: Path | str | None = None) -> None:
        settings: Settings = get_settings()
        self.root = Path(root) if root else settings.ingestion.local_storage_root
        self.root.mkdir(parents=True, exist_ok=True)

    def path_for(self, key: str) -> Path:
        """Return the path of a key inside the store."""
        return self.root / key

    def put(self, key: str, stream: BinaryIO, max_bytes: int | None = None) -> int:
        """Store the content of a stream under a key.

        The stream is copied in chunks, so a large file never has to fit in
        the memory.  When the file is bigger than ``max_bytes`` the partial
        file is removed and an error is raised.
        """
        target = self.path_for(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".part")
        written = 0
        try:
            with temporary.open("wb") as handle:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if max_bytes is not None and written > max_bytes:
                        raise ValueError(
                            f"the file is bigger than the allowed {max_bytes} bytes"
                        )
                    handle.write(chunk)
            temporary.replace(target)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        logger.info("stored %s (%s bytes)", key, written)
        return written

    def open(self, key: str) -> BinaryIO:
        """Open the object of a key for reading."""
        return self.path_for(key).open("rb")

    def exists(self, key: str) -> bool:
        """Return True when the key exists."""
        return self.path_for(key).exists()

    def delete(self, key: str) -> None:
        """Remove the object of a key."""
        self.path_for(key).unlink(missing_ok=True)

    def clear(self) -> None:
        """Remove every object of the store."""
        if self.root.exists():
            shutil.rmtree(self.root, ignore_errors=True)
        self.root.mkdir(parents=True, exist_ok=True)


class S3ObjectStore:
    """An Amazon S3 based object store.

    The bucket is written once, the file is read back in chunks, so a large
    upload never has to fit in the memory of the worker either.
    """

    def __init__(self, bucket: str | None = None, prefix: str = "incoming") -> None:
        import boto3

        settings = get_settings()
        self.bucket = bucket or settings.ingestion.s3_bucket
        self.prefix = prefix.strip("/")
        self.client = boto3.client("s3", region_name=settings.aws_region)

    def key_for(self, key: str) -> str:
        """Return the full key of an object inside the bucket."""
        return f"{self.prefix}/{key}" if self.prefix else key

    def put(self, key: str, stream: BinaryIO, max_bytes: int | None = None) -> int:
        """Upload the content of a stream to the bucket."""
        from boto3.s3.transfer import TransferConfig

        config = TransferConfig(multipart_threshold=8 * 1024 * 1024)
        extra = {"ContentType": "text/csv"}
        if max_bytes is not None:
            extra["ContentLength"] = max_bytes
        self.client.upload_fileobj(stream, self.bucket, self.key_for(key), ExtraArgs=extra, Config=config)
        return max_bytes or 0

    def open(self, key: str) -> BinaryIO:
        """Open the object of a key for reading."""
        return self.client.get_object(Bucket=self.bucket, Key=self.key_for(key))["Body"]

    def exists(self, key: str) -> bool:
        """Return True when the key exists."""
        from botocore.exceptions import ClientError

        try:
            self.client.head_object(Bucket=self.bucket, Key=self.key_for(key))
            return True
        except ClientError:
            return False

    def delete(self, key: str) -> None:
        """Remove the object of a key."""
        self.client.delete_object(Bucket=self.bucket, Key=self.key_for(key))


def get_object_store(settings: Settings | None = None) -> ObjectStore:
    """Return the object store the configuration asks for."""
    resolved = settings or get_settings()
    if resolved.ingestion.storage == "s3":
        return S3ObjectStore()
    return LocalObjectStore()
