-- Migration: real YouTube channel and video statistics
-- Run this in your Supabase SQL editor
--
-- Counts are bigint, not int: channel view counts routinely exceed 2^31 and would
-- overflow a plain integer. video_count stays int — no channel has 2 billion uploads.

ALTER TABLE creators ADD COLUMN IF NOT EXISTS subscriber_count bigint;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS channel_view_count bigint;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS channel_video_count int;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS channel_stats_updated_at timestamptz;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS like_count bigint;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS view_count bigint;

-- Append-only history. The columns above hold "now"; this holds "over time", which
-- is the only way to answer growth questions later — a single mutable row can't.
CREATE TABLE IF NOT EXISTS channel_stats_snapshots (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references creators(id) not null,
  subscriber_count bigint,
  channel_view_count bigint,
  recorded_at timestamptz default now()
);

-- Growth queries are always "this creator, ordered by time".
CREATE INDEX IF NOT EXISTS channel_stats_snapshots_creator_time_idx
  ON channel_stats_snapshots (creator_id, recorded_at DESC);
