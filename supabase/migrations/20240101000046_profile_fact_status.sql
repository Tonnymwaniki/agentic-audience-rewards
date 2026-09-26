-- Migration 46: confidence status for Business Profile facts (lib/profile-fact-status.ts).
--
-- One row per filled-in profile field (fixed creators columns and custom fields):
--   confirmed_at — when the creator last set or reconfirmed the value. STALE after
--                  90 days; "Yes, still accurate" on the profile page refreshes it.
--   contradicted_* — set by the daily job when a cluster of recent comments from
--                  several people consistently says something different from the
--                  value. contradicted_value records WHICH value was contradicted, so
--                  editing the field resolves it automatically; reconfirming clears it.
-- While contradicted, drafted replies treat the field as uncertain rather than fact.
--
-- Existing values have no edit history, so their clock starts when the daily job
-- first records them — nothing is reported stale for at least 90 days after this.
-- RLS on with no policies (service role only); rows go with the creator.

CREATE TABLE IF NOT EXISTS profile_fact_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('fixed', 'custom')),
  field_key text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  contradicted_at timestamptz,
  contradicted_value text,
  contradiction_summary text,
  contradiction_example text,
  contradiction_comment_ids uuid[],
  UNIQUE (creator_id, source, field_key)
);

ALTER TABLE profile_fact_status ENABLE ROW LEVEL SECURITY;
