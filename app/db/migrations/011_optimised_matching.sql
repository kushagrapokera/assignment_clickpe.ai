-- ===========================================================================
-- Optimised matching storage and durable dispatch
--
-- Three concerns are added here:
--
--  * `storage_mode` marks the batches that were matched with the optimised
--    storage.  A batch that was matched before this migration keeps its rows
--    untouched; only a new batch (or a batch that is reprocessed on purpose)
--    is written with the new layout.
--  * `matching_dispatches` is the durable handover from the ingestion worker
--    to the matching workflow.  The attempt, the failure and the recovery are
--    recorded, so a restart of the worker never loses or duplicates a batch.
--  * `matching_runs` holds the measurements of a run: how long the stages
--    took, how many bytes travelled through the workflow and how many rows
--    were written.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Which batches use the optimised storage
-- ---------------------------------------------------------------------------
ALTER TABLE ingestion_batches
    ADD COLUMN IF NOT EXISTS storage_mode TEXT NOT NULL DEFAULT 'legacy';

-- ---------------------------------------------------------------------------
-- Durable dispatch of the matching of a batch
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matching_dispatches (
    dispatch_id   BIGSERIAL PRIMARY KEY,
    batch_id      UUID        NOT NULL REFERENCES ingestion_batches (batch_id) ON DELETE CASCADE,
    status        TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'dispatching', 'dispatched', 'completed', 'failed')),
    attempts      INTEGER     NOT NULL DEFAULT 0,
    last_error    TEXT,
    available_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at     TIMESTAMPTZ,
    locked_by     TEXT,
    dispatched_at TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One dispatch per batch: a retry updates the row instead of adding one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_matching_dispatches_batch
    ON matching_dispatches (batch_id);
CREATE INDEX IF NOT EXISTS idx_matching_dispatches_status
    ON matching_dispatches (status, available_at);

-- ---------------------------------------------------------------------------
-- The measurements of a matching run
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matching_runs (
    run_id            UUID        PRIMARY KEY,
    batch_id          UUID        REFERENCES ingestion_batches (batch_id) ON DELETE CASCADE,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ,
    applicants        INTEGER     NOT NULL DEFAULT 0,
    products          INTEGER     NOT NULL DEFAULT 0,
    candidate_pairs   INTEGER     NOT NULL DEFAULT 0,
    evaluated_pairs   INTEGER     NOT NULL DEFAULT 0,
    decisions_written INTEGER     NOT NULL DEFAULT 0,
    matches_written   INTEGER     NOT NULL DEFAULT 0,
    external_updates  INTEGER     NOT NULL DEFAULT 0,
    payload_bytes     BIGINT      NOT NULL DEFAULT 0,
    fetch_ms          BIGINT,
    rules_ms          BIGINT,
    persist_ms        BIGINT,
    external_ms       BIGINT,
    notifications_ms  BIGINT,
    llm_requests      INTEGER     NOT NULL DEFAULT 0,
    llm_verdicts      INTEGER     NOT NULL DEFAULT 0,
    prompt_tokens     INTEGER     NOT NULL DEFAULT 0,
    completion_tokens INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_matching_runs_batch ON matching_runs (batch_id);

-- ---------------------------------------------------------------------------
-- Counters of the runtime, for example the peak of concurrent batches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runtime_metrics (
    metric     TEXT        PRIMARY KEY,
    value      JSONB       NOT NULL DEFAULT '{}'::JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- One notification per applicant and batch
--
-- A batch that is dispatched twice must not send the same mail twice, so the
-- notification carries the batch it belongs to and the pair is unique.
-- ---------------------------------------------------------------------------
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES ingestion_batches (batch_id) ON DELETE SET NULL;
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_batch
    ON notifications (user_id, batch_id)
    WHERE batch_id IS NOT NULL;
