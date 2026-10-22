-- ===========================================================================
-- The addresses that are allowed to receive a notification.
--
-- The applicant file of the assignment contains addresses that must never be
-- mailed.  Only the addresses of this list receive a notification, which
-- makes the rule auditable instead of a hidden check inside a workflow.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS notification_recipients (
    address     TEXT        PRIMARY KEY,
    label       TEXT,
    active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO notification_recipients (address, label)
VALUES
    ('alerts@loan-engine.test', 'local mailpit inbox'),
    ('alerts+one@loan-engine.test', 'local mailpit alias one'),
    ('alerts+two@loan-engine.test', 'local mailpit alias two')
ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label;
