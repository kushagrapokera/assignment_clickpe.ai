-- Keep rejected and pending pairs too: absence of a match is not a decision.
CREATE TABLE matching_decisions (
    batch_id UUID NOT NULL REFERENCES ingestion_batches(batch_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES loan_products(product_id) ON DELETE CASCADE,
    lane TEXT NOT NULL CHECK (lane IN ('rules', 'qualitative')),
    status TEXT NOT NULL CHECK (status IN ('eligible', 'ineligible', 'review', 'pending')),
    reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (batch_id, user_id, product_id)
);
CREATE INDEX matching_decisions_batch_lane ON matching_decisions(batch_id, lane, user_id);

-- Historical matches remain browseable, but never invent historical rejections.
CREATE VIEW ui_decisions AS
SELECT batch_id, user_id, product_id, lane, status, reasons, TRUE AS recorded
FROM matching_decisions
UNION ALL
SELECT m.batch_id, m.user_id, m.product_id,
       CASE WHEN m.decided_by = 'rules' THEN 'rules' ELSE 'qualitative' END,
       CASE WHEN m.status = 'eligible' THEN 'eligible' ELSE 'review' END,
       m.reasons, FALSE
FROM matches m
WHERE NOT EXISTS (
    SELECT 1 FROM matching_decisions d
    WHERE d.batch_id = m.batch_id AND d.user_id = m.user_id AND d.product_id = m.product_id
);
