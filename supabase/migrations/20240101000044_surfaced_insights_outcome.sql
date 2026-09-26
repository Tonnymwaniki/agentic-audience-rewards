-- Migration 44: surfaced_insights records every Insight Agent verdict, not only the
-- ones that became notifications — a theme Claude judged "not notable" is suppressed
-- for the same 7 days, so it isn't re-sent to the AI every day.
--
-- `outcome` keeps the two apart, so the table still answers "what actually reached
-- the creator's inbox?". Rows written before this column existed were all
-- notifications, hence the backfill. The agent works without this column (it just
-- can't label the rows), so this can be applied at any time.

ALTER TABLE surfaced_insights ADD COLUMN IF NOT EXISTS outcome text;

UPDATE surfaced_insights SET outcome = 'notified' WHERE outcome IS NULL;

ALTER TABLE surfaced_insights
  DROP CONSTRAINT IF EXISTS surfaced_insights_outcome_check;
ALTER TABLE surfaced_insights
  ADD CONSTRAINT surfaced_insights_outcome_check CHECK (outcome IN ('notified', 'rejected'));
