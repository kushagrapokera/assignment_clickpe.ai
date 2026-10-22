"""Central configuration for the Loan Eligibility Engine.

Every tunable value is read from the environment (populated from ``.env`` by
``load_dotenv``).  Nothing in the code base reads ``os.environ`` directly, so
there is exactly one place to look when a setting changes.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = PROJECT_ROOT / "app" / "db" / "migrations"
N8N_CODE_DIR = PROJECT_ROOT / "n8n" / "code"
N8N_SOURCES_FILE = PROJECT_ROOT / "n8n" / "sources" / "sources.json"


def load_dotenv(path: Path | None = None) -> None:
    """Load ``.env`` into ``os.environ`` without overriding real env vars."""
    env_path = path or (PROJECT_ROOT / ".env")
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _as_int(value: str | None, default: int) -> int:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class DatabaseSettings:
    """Connection details for the application PostgreSQL database."""

    host: str
    port: int
    database: str
    user: str
    password: str
    sslmode: str = "prefer"

    @property
    def dsn(self) -> str:
        """libpq connection string used by psycopg2."""
        return (
            f"host={self.host} port={self.port} dbname={self.database} "
            f"user={self.user} password={self.password} sslmode={self.sslmode}"
        )

    def safe_dsn(self) -> str:
        """Connection string with the password redacted, safe for logging."""
        return (
            f"host={self.host} port={self.port} dbname={self.database} "
            f"user={self.user} password=*** sslmode={self.sslmode}"
        )


@dataclass(frozen=True)
class N8nSettings:
    """Connection details for the self-hosted n8n instance."""

    api_url: str
    api_key: str
    matching_webhook_url: str
    notification_webhook_url: str
    discovery_webhook_url: str
    relay_shared_secret: str


@dataclass(frozen=True)
class LlmSettings:
    """OpenAI-compatible LLM endpoint used by the qualitative matching stage."""

    base_url: str
    api_key: str
    model: str
    timeout_seconds: int = 60
    max_tokens: int = 512


@dataclass(frozen=True)
class NotificationSettings:
    """Outbound email configuration."""

    provider: str
    from_email: str
    test_recipient_email: str
    allowlist: tuple[str, ...]
    max_attempts: int
    timeout_seconds: int
    smtp_host: str
    smtp_port: int
    smtp_secure: bool
    smtp_user: str
    smtp_password: str
    ses_from_email: str


@dataclass(frozen=True)
class IngestionSettings:
    """Limits and behaviour of the CSV ingestion pipeline."""

    storage: str
    local_storage_root: Path
    s3_bucket: str
    s3_prefix: str
    presign_expiry_seconds: int
    csv_max_bytes: int
    csv_max_rows: int
    lease_seconds: int
    overlap_backoff_seconds: int
    queue_batch_size: int
    commit_rows: int
    max_attempts: int
    sqs_queue_url: str
    trigger_matching: bool
    chunk_rows: int
    chunk_delay_seconds: float


@dataclass(frozen=True)
class MatchingSettings:
    """How the batches are handed over to the matching workflow."""

    max_concurrency: int = 2
    max_attempts: int = 3
    lease_seconds: int = 300
    webhook_timeout: int = 30
    poll_seconds: float = 2.0


@dataclass(frozen=True)
class Settings:
    """Aggregate of every configuration group used by the application."""

    database: DatabaseSettings
    n8n: N8nSettings
    llm: LlmSettings
    notification: NotificationSettings
    ingestion: IngestionSettings
    matching: MatchingSettings = field(default_factory=MatchingSettings)
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    api_base_url: str = "http://127.0.0.1:8000"
    public_base_url: str = "http://127.0.0.1:8000"
    max_upload_bytes: int = 20 * 1024 * 1024
    log_level: str = "INFO"
    aws_region: str = "us-east-1"
    extra: dict[str, str] = field(default_factory=dict)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Build the immutable settings object from the process environment."""
    load_dotenv()

    database = DatabaseSettings(
        host=os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        port=_as_int(os.environ.get("POSTGRES_PORT"), 5432),
        database=os.environ.get("POSTGRES_DB", "loan_clickpe"),
        user=os.environ.get("POSTGRES_USER", "loan_admin"),
        password=os.environ.get("POSTGRES_PASSWORD", ""),
        sslmode=os.environ.get("POSTGRES_SSLMODE", "disable"),
    )

    n8n = N8nSettings(
        api_url=os.environ.get("N8N_API_URL", "http://127.0.0.1:5678").rstrip("/"),
        api_key=os.environ.get("N8N_API_KEY", ""),
        matching_webhook_url=os.environ.get(
            "N8N_MATCHING_WEBHOOK_URL", "http://127.0.0.1:5678/webhook/loan-matching"
        ),
        notification_webhook_url=os.environ.get(
            "N8N_NOTIFICATION_WEBHOOK_URL",
            "http://127.0.0.1:5678/webhook/loan-notification",
        ),
        discovery_webhook_url=os.environ.get(
            "N8N_DISCOVERY_WEBHOOK_URL", "http://127.0.0.1:5678/webhook/loan-discovery"
        ),
        relay_shared_secret=os.environ.get("RELAY_SHARED_SECRET", ""),
    )

    llm = LlmSettings(
        base_url=os.environ.get("OLLAMA_BASE_URL", "https://ollama.com").rstrip("/"),
        api_key=os.environ.get("OLLAMA_API_KEY", ""),
        model=os.environ.get("OLLAMA_MODEL", "gemma4:31b"),
        timeout_seconds=_as_int(os.environ.get("LLM_TIMEOUT_SECONDS"), 60),
        max_tokens=_as_int(os.environ.get("LLM_MAX_TOKENS"), 512),
    )

    allowlist_raw = os.environ.get("TEST_RECIPIENT_ALLOWLIST", "")
    allowlist = tuple(
        item.strip().lower()
        for item in allowlist_raw.replace(";", ",").split(",")
        if item.strip()
    )

    notification = NotificationSettings(
        provider=os.environ.get("NOTIFICATION_PROVIDER", "local"),
        from_email=os.environ.get("NOTIFICATION_FROM_EMAIL", "alerts@loan-engine.test"),
        test_recipient_email=os.environ.get("TEST_RECIPIENT_EMAIL", ""),
        allowlist=allowlist,
        max_attempts=_as_int(os.environ.get("NOTIFICATION_MAX_ATTEMPTS"), 3),
        timeout_seconds=_as_int(os.environ.get("NOTIFICATION_SENDING_TIMEOUT_SECONDS"), 300),
        smtp_host=os.environ.get("SMTP_HOST", "127.0.0.1"),
        smtp_port=_as_int(os.environ.get("SMTP_PORT"), 1025),
        smtp_secure=_as_bool(os.environ.get("SMTP_SECURE")),
        smtp_user=os.environ.get("SMTP_USER", ""),
        smtp_password=os.environ.get("SMTP_PASSWORD", ""),
        ses_from_email=os.environ.get("SES_FROM_EMAIL", ""),
    )

    ingestion = IngestionSettings(
        storage=os.environ.get("INGESTION_STORAGE", "local"),
        local_storage_root=PROJECT_ROOT
        / os.environ.get("LOCAL_STORAGE_ROOT", ".local-ingestion"),
        s3_bucket=os.environ.get("S3_UPLOAD_BUCKET", ""),
        s3_prefix=os.environ.get("S3_UPLOAD_PREFIX", "incoming"),
        presign_expiry_seconds=_as_int(os.environ.get("PRESIGN_EXPIRY_SECONDS"), 900),
        csv_max_bytes=_as_int(os.environ.get("CSV_MAX_BYTES"), 20 * 1024 * 1024),
        csv_max_rows=_as_int(os.environ.get("CSV_MAX_ROWS"), 50000),
        lease_seconds=_as_int(os.environ.get("INGESTION_LEASE_SECONDS"), 900),
        overlap_backoff_seconds=_as_int(os.environ.get("OVERLAP_BACKOFF_SECONDS"), 15),
        queue_batch_size=_as_int(os.environ.get("INGESTION_QUEUE_BATCH_SIZE"), 1),
        commit_rows=_as_int(os.environ.get("INGESTION_COMMIT_ROWS"), 2000),
        max_attempts=_as_int(os.environ.get("INGESTION_MAX_ATTEMPTS"), 3),
        sqs_queue_url=os.environ.get("SQS_QUEUE_URL", ""),
        trigger_matching=_as_bool(os.environ.get("INGESTION_TRIGGER_MATCHING"), True),
        chunk_rows=_as_int(os.environ.get("INGESTION_CHUNK_ROWS"), 500),
        chunk_delay_seconds=float(
            os.environ.get("INGESTION_CHUNK_DELAY_SECONDS", "10")
        ),
    )

    matching = MatchingSettings(
        max_concurrency=_as_int(os.environ.get("MATCHING_MAX_CONCURRENCY"), 2),
        max_attempts=_as_int(os.environ.get("MATCHING_MAX_ATTEMPTS"), 3),
        lease_seconds=_as_int(os.environ.get("MATCHING_LEASE_SECONDS"), 300),
        webhook_timeout=_as_int(os.environ.get("MATCHING_WEBHOOK_TIMEOUT"), 30),
        poll_seconds=float(os.environ.get("MATCHING_POLL_SECONDS", "2")),
    )

    return Settings(
        database=database,
        n8n=n8n,
        llm=llm,
        notification=notification,
        ingestion=ingestion,
        matching=matching,
        api_host=os.environ.get("API_HOST", "0.0.0.0"),
        api_port=_as_int(os.environ.get("API_PORT"), 8000),
        api_base_url=os.environ.get("API_BASE_URL", "http://127.0.0.1:8000"),
        public_base_url=os.environ.get("PUBLIC_BASE_URL", "http://127.0.0.1:8000"),
        max_upload_bytes=_as_int(os.environ.get("API_MAX_UPLOAD_BYTES"), 20 * 1024 * 1024),
        log_level=os.environ.get("LOG_LEVEL", "INFO"),
        aws_region=os.environ.get("AWS_REGION", "us-east-1"),
    )
