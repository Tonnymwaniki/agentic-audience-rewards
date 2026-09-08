-- Migration: mark comments that a human must answer personally
-- Run this in your Supabase SQL editor
--
-- When escalation_flag is set, no draft_reply is written for that comment at all —
-- the flag and a drafted reply are mutually exclusive by design, not by convention.
-- Free text rather than an enum so a new category can be added without a migration.

ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS escalation_flag text;

-- "What needs my personal attention" is the query this column exists to answer.
CREATE INDEX IF NOT EXISTS comment_categories_escalation_idx
  ON comment_categories (escalation_flag)
  WHERE escalation_flag IS NOT NULL;
