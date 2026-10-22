-- ===========================================================================
-- The email address is contact data, not an identifier.
--
-- The applicant file of the assignment contains 10 000 distinct user ids but
-- only 2 632 distinct email addresses, so several applicants share an
-- address.  A unique index on the email would reject 7 368 of the 10 000
-- rows, which is why the user id is the primary key and the email is only
-- indexed for lookups.
-- ===========================================================================

DROP INDEX IF EXISTS idx_users_email;

CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));

-- The number of applicants that share an address is worth knowing, so it is
-- tracked per batch.
ALTER TABLE ingestion_batches
    ADD COLUMN IF NOT EXISTS unique_emails INTEGER NOT NULL DEFAULT 0;
