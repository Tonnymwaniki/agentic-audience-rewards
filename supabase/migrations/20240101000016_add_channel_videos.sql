-- Migration: lightweight tracking of every video on a connected channel
-- Run this in your Supabase SQL editor
--
-- Distinct from `posts`, which only ever holds FULLY ingested videos (comments
-- fetched, categorized, drafted). channel_videos is the cheap index of what exists
-- on the channel at all: a row per video with just title/thumbnail/date, and
-- post_id null until that video is actually analyzed.

CREATE TABLE IF NOT EXISTS channel_videos (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references creators(id) not null,
  video_id text not null,
  title text,
  thumbnail_url text,
  published_at timestamptz,
  post_id uuid references posts(id),
  discovered_at timestamptz default now(),
  unique(creator_id, video_id)
);

ALTER TABLE creators ADD COLUMN IF NOT EXISTS auto_analyze_enabled boolean DEFAULT false;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS last_channel_check_at timestamptz;

-- "This creator's videos, newest first" and "which are not yet analyzed" are the
-- two reads this table exists for.
CREATE INDEX IF NOT EXISTS channel_videos_creator_published_idx
  ON channel_videos (creator_id, published_at DESC);

CREATE INDEX IF NOT EXISTS channel_videos_unanalyzed_idx
  ON channel_videos (creator_id)
  WHERE post_id IS NULL;

-- Row-level security.
--
-- NOTE: no other table in this schema has RLS enabled — the app runs its writes
-- through the service-role key and scopes reads by creator_id in application code.
-- The policy below is therefore additive protection for this table only, not a
-- house style being followed. Service-role connections bypass RLS entirely, so
-- every existing write path keeps working; this only constrains a client reading
-- with an end-user's own token.
ALTER TABLE channel_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_videos_select_own ON channel_videos;
CREATE POLICY channel_videos_select_own ON channel_videos
  FOR SELECT
  USING (
    creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
  );
