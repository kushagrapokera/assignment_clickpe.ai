-- ===========================================================================
-- Catalogue hygiene
--
--  * `variants` keeps the pages a canonical product was merged from, so the
--    provenance of a collapsed product is never lost.
--  * `last_seen_at` powers the deactivation sweep: a product that is no
--    longer published is marked inactive instead of silently disappearing.
--  * `products_collapsed` shows in the discovery log how many records were
--    merged into a canonical product.
-- ===========================================================================

ALTER TABLE loan_products
    ADD COLUMN IF NOT EXISTS variants JSONB NOT NULL DEFAULT '[]'::JSONB;

ALTER TABLE loan_products
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

ALTER TABLE discovery_runs
    ADD COLUMN IF NOT EXISTS products_collapsed INTEGER NOT NULL DEFAULT 0;

UPDATE loan_products
SET last_seen_at = updated_at
WHERE last_seen_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_loan_products_last_seen ON loan_products (last_seen_at);
