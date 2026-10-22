-- ===========================================================================
-- Loan Eligibility Engine - initial schema
--
-- The database holds four distinct concerns:
--   * discovered reference data  -> loan_products
--   * ingested applicant data    -> users, ingestion_batches, ingestion_queue
--   * matching results            -> matches, llm_verdict_cache
--   * notification bookkeeping    -> notifications
--
-- Every statement is idempotent so the migration runner can be replayed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Discovered loan products
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_products (
    product_id                 BIGSERIAL PRIMARY KEY,
    product_key                TEXT        NOT NULL UNIQUE,
    product_name               TEXT        NOT NULL,
    provider                   TEXT        NOT NULL,
    source_id                  TEXT        NOT NULL,
    source_url                 TEXT        NOT NULL,

    interest_rate_min          NUMERIC(6, 3),
    interest_rate_max          NUMERIC(6, 3),

    min_loan_amount            NUMERIC(14, 2),
    max_loan_amount            NUMERIC(14, 2),

    min_tenure_months          INTEGER,
    max_tenure_months          INTEGER,

    -- Eligibility criteria (the fields the matcher filters on)
    min_monthly_income         NUMERIC(14, 2),
    max_monthly_income         NUMERIC(14, 2),
    min_credit_score           INTEGER,
    max_credit_score           INTEGER,
    min_age                    INTEGER,
    max_age                    INTEGER,
    min_employment_years       NUMERIC(4, 2),
    required_employment_statuses TEXT[]    NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Normalised criteria signature.  Products that share a signature are
    -- interchangeable from the matcher's point of view, which lets the
    -- matcher bucket candidates instead of scoring every pair separately.
    criteria_signature         TEXT        NOT NULL,
    -- Raw evidence: every extracted eligibility line, kept for auditability
    -- and for feeding the LLM stage with verifiable context.
    criteria                   JSONB       NOT NULL DEFAULT '{}'::JSONB,
    raw                        JSONB       NOT NULL DEFAULT '{}'::JSONB,

    discovered_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active                     BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_loan_products_signature ON loan_products (criteria_signature);
CREATE INDEX IF NOT EXISTS idx_loan_products_provider  ON loan_products (provider);
CREATE INDEX IF NOT EXISTS idx_loan_products_active    ON loan_products (active);

-- ---------------------------------------------------------------------------
-- Ingested applicants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    user_id            TEXT        PRIMARY KEY,
    name               TEXT,
    email              TEXT        NOT NULL,
    monthly_income     NUMERIC(14, 2),
    annual_income      NUMERIC(14, 2),
    credit_score       INTEGER,
    employment_status  TEXT,
    age                INTEGER,
    city               TEXT,
    existing_emi       NUMERIC(14, 2),
    batch_id           UUID,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_users_batch ON users (batch_id);
-- Range predicates used by the SQL pre-filter stage.
CREATE INDEX IF NOT EXISTS idx_users_profile
    ON users (credit_score, age, monthly_income);

-- ---------------------------------------------------------------------------
-- Ingestion bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingestion_batches (
    batch_id       UUID        PRIMARY KEY,
    filename       TEXT        NOT NULL,
    object_key     TEXT,
    status         TEXT        NOT NULL DEFAULT 'queued',
    total_rows     INTEGER     NOT NULL DEFAULT 0,
    accepted_rows  INTEGER     NOT NULL DEFAULT 0,
    rejected_rows  INTEGER     NOT NULL DEFAULT 0,
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ingestion_queue (
    queue_id     BIGSERIAL PRIMARY KEY,
    batch_id     UUID        NOT NULL REFERENCES ingestion_batches (batch_id) ON DELETE CASCADE,
    payload      JSONB       NOT NULL DEFAULT '{}'::JSONB,
    status       TEXT        NOT NULL DEFAULT 'pending',
    attempts     INTEGER     NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at    TIMESTAMPTZ,
    locked_by    TEXT,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_queue_claim
    ON ingestion_queue (status, available_at);

CREATE TABLE IF NOT EXISTS ingestion_row_errors (
    error_id    BIGSERIAL PRIMARY KEY,
    batch_id    UUID        NOT NULL REFERENCES ingestion_batches (batch_id) ON DELETE CASCADE,
    row_number  INTEGER     NOT NULL,
    raw_row     JSONB       NOT NULL DEFAULT '{}'::JSONB,
    message     TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_row_errors_batch
    ON ingestion_row_errors (batch_id);

-- ---------------------------------------------------------------------------
-- Matching results
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matches (
    match_id        BIGSERIAL PRIMARY KEY,
    user_id         TEXT        NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    product_id      BIGINT      NOT NULL REFERENCES loan_products (product_id) ON DELETE CASCADE,
    status          TEXT        NOT NULL CHECK (status IN ('eligible', 'likely', 'ineligible')),
    decided_by      TEXT        NOT NULL CHECK (decided_by IN ('sql_prefilter', 'rules', 'llm')),
    score           NUMERIC(5, 4),
    reasons         JSONB       NOT NULL DEFAULT '[]'::JSONB,
    llm_assessment  JSONB,
    batch_id        UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_user    ON matches (user_id);
CREATE INDEX IF NOT EXISTS idx_matches_product ON matches (product_id);
CREATE INDEX IF NOT EXISTS idx_matches_status  ON matches (status);
CREATE INDEX IF NOT EXISTS idx_matches_batch   ON matches (batch_id);

-- Cache of LLM verdicts.  The key is (criteria signature, applicant fact
-- bucket): every applicant that lands in the same bucket and faces the same
-- criteria profile reuses the same verdict, which is what keeps the number
-- of LLM calls proportional to the number of *distinct* decisions instead of
-- the number of user/product pairs.
CREATE TABLE IF NOT EXISTS llm_verdict_cache (
    cache_key        TEXT        PRIMARY KEY,
    criteria_signature TEXT      NOT NULL,
    user_bucket      TEXT        NOT NULL,
    verdict          TEXT        NOT NULL,
    score            NUMERIC(5, 4),
    reasons          JSONB       NOT NULL DEFAULT '[]'::JSONB,
    model            TEXT,
    prompt_tokens    INTEGER,
    completion_tokens INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    hits             INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_llm_verdict_cache_sig
    ON llm_verdict_cache (criteria_signature);

-- ---------------------------------------------------------------------------
-- Discovery run log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discovery_runs (
    run_id         UUID        PRIMARY KEY,
    source_id      TEXT        NOT NULL,
    trigger        TEXT        NOT NULL DEFAULT 'schedule',
    status         TEXT        NOT NULL DEFAULT 'running',
    http_status    INTEGER,
    products_found INTEGER     NOT NULL DEFAULT 0,
    products_new   INTEGER     NOT NULL DEFAULT 0,
    products_updated INTEGER   NOT NULL DEFAULT 0,
    error          TEXT,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_source ON discovery_runs (source_id);

-- ---------------------------------------------------------------------------
-- Notification bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    notification_id BIGSERIAL PRIMARY KEY,
    user_id         TEXT        NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    match_count     INTEGER     NOT NULL DEFAULT 0,
    recipient       TEXT        NOT NULL,
    provider        TEXT        NOT NULL DEFAULT 'local',
    status          TEXT        NOT NULL DEFAULT 'pending',
    provider_message_id TEXT,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id);
