-- Matching progresses independently of CSV ingestion and can expose fast results.
ALTER TABLE ingestion_batches
    ADD COLUMN IF NOT EXISTS matching_status TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS matching_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fast_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS matching_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS matching_pending_pairs INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS notifications_completed_at TIMESTAMPTZ;
