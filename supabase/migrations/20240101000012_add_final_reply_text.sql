-- Migration: capture the reply the creator actually sends, and whether they changed it
-- Run this in your Supabase SQL editor
--
-- draft_reply stays the agent's original, untouched output. final_reply_text is what
-- the creator approved. Keeping both is the whole point: the pair (draft_reply,
-- final_reply_text) where reply_was_edited = true is a corrections dataset — what the
-- agent wrote next to what a human decided it should have said.

ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS final_reply_text text;
ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS reply_was_edited boolean DEFAULT false;

-- Makes "show me every correction" a cheap query rather than a full scan, which is
-- how this data will be read when it's used for learning.
CREATE INDEX IF NOT EXISTS comment_categories_edited_idx
  ON comment_categories (reply_was_edited)
  WHERE reply_was_edited = true;
