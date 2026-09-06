-- Migration: track when a comment was last considered for draft regeneration
-- Run this in your Supabase SQL editor
--
-- Distinct from draft_reply_created_at: this is stamped on EVERY comment the
-- regeneration pass looks at — including ones skipped as casual and ones that
-- failed — so a capped run can order by it and always move forward instead of
-- re-processing the same batch.

ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS draft_reply_checked_at timestamptz;
