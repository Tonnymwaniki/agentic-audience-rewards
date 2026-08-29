-- Migration: add draft_reply to comment_categories
ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS draft_reply text;
