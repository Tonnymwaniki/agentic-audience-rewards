-- Migration: track when a drafted reply was actually generated, separate from
-- the underlying comment's posted_at, so "pending" feed items show accurate age
-- Run this in your Supabase SQL editor

ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS draft_reply_created_at timestamptz DEFAULT now();
