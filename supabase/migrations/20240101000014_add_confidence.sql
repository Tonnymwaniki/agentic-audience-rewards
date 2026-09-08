-- Migration: record how sure the agent was, not just what it decided
-- Run this in your Supabase SQL editor
--
-- Nullable and unconstrained on purpose. Rows written before this existed have no
-- confidence, and that is a different fact from "the agent was unsure" — the UI
-- shows no badge rather than guessing. Kept as free text rather than an enum so a
-- future scale (a number, or an extra level) doesn't need a migration to land.

ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS confidence text;
ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS draft_confidence text;

-- "Show me the ones worth double-checking" is the query this data exists to answer,
-- so make it cheap rather than a full scan.
CREATE INDEX IF NOT EXISTS reward_events_low_confidence_idx
  ON reward_events (confidence)
  WHERE confidence = 'low';

CREATE INDEX IF NOT EXISTS comment_categories_low_confidence_idx
  ON comment_categories (draft_confidence)
  WHERE draft_confidence = 'low';
