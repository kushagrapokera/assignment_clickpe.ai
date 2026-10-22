-- ===========================================================================
-- An upload is a file, a batch is a piece of work.
--
-- A file with many applicants is split into batches of a few thousand rows,
-- because a workflow run has to stay small: the Code node of n8n has a few
-- seconds before the engine hands the next task on.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ingestion_uploads (
    upload_id    UUID        PRIMARY KEY,
    filename    TEXT        NOT NULL,
    object_key  TEXT,
    size_bytes  BIGINT,
    status      TEXT        NOT NULL DEFAULT 'queued',
    total_rows  INTEGER     NOT NULL DEFAULT 0,
    accepted_rows INTEGER   NOT NULL DEFAULT 0,
    rejected_rows INTEGER   NOT NULL DEFAULT 0,
    chunk_size  INTEGER     NOT NULL DEFAULT 1000,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

ALTER TABLE ingestion_batches
    ADD COLUMN IF NOT EXISTS upload_id UUID REFERENCES ingestion_uploads (upload_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ingestion_batches_upload ON ingestion_batches (upload_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_uploads_created ON ingestion_uploads (created_at DESC);
