-- Migration: add tracked_videos table for scheduled comment polling
-- Run this in your Supabase SQL editor

CREATE TABLE IF NOT EXISTS tracked_videos (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references creators(id) not null,
  post_id uuid references posts(id) not null,
  last_checked_at timestamptz default now(),
  polling_enabled boolean default true,
  unique(creator_id, post_id)
);

-- Speeds up the cron query: polling_enabled = true AND last_checked_at < threshold
CREATE INDEX IF NOT EXISTS tracked_videos_polling_idx
  ON tracked_videos (polling_enabled, last_checked_at);
