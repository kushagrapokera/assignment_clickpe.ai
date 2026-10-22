-- ===========================================================================
-- A job of the queue belongs to an upload, not to a batch.
--
-- An upload is split into several batches, and the batches are created by
-- the worker while it processes the job.  The job itself therefore points at
-- the upload it came from.
-- ===========================================================================

ALTER TABLE ingestion_queue
    DROP CONSTRAINT IF EXISTS ingestion_queue_batch_id_fkey;

ALTER TABLE ingestion_queue
    ADD COLUMN IF NOT EXISTS upload_id UUID REFERENCES ingestion_uploads (upload_id) ON DELETE CASCADE;

UPDATE ingestion_queue q
SET upload_id = b.upload_id
FROM ingestion_batches b
WHERE b.batch_id = q.batch_id AND q.upload_id IS NULL;

ALTER TABLE ingestion_queue
    DROP COLUMN IF EXISTS batch_id;

CREATE INDEX IF NOT EXISTS idx_ingestion_queue_upload ON ingestion_queue (upload_id);
