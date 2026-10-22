-- Optional evidence used by deterministic policy checks; standard CSV unchanged.
ALTER TABLE users ADD COLUMN IF NOT EXISTS eligibility_facts JSONB NOT NULL DEFAULT '{}'::jsonb;
