-- Migration: track whether a drafted reply has been approved by the creator
-- Run this in your Supabase SQL editor

ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS draft_reply_approved_at timestamptz;
