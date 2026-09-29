-- Which channel each video belongs to, for grouping/filtering in My Videos.
--
-- A creator can research several different channels under one account (Connect's
-- "analyze any channel" path), and until now nothing distinguished them: posts had
-- channel_id (added for ownership gating, migration 36) but no human-readable
-- title, and channel_videos — the lightweight, not-yet-analyzed index — had no
-- channel identifier at all, so every video from every channel a creator had ever
-- looked at showed up in one flat, unlabeled list.
--
-- Nullable on purpose, same reasoning as migration 36: rows written before this
-- exists simply have no value until the video is re-synced or re-ingested. The
-- app groups anything with a null channel_id into a single "Unknown channel"
-- bucket rather than failing or hiding it.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS channel_title text;

COMMENT ON COLUMN posts.channel_title IS
  'YouTube channel display name, from snippet.channelTitle. Paired with channel_id for grouping in My Videos.';

ALTER TABLE channel_videos ADD COLUMN IF NOT EXISTS channel_id text;
ALTER TABLE channel_videos ADD COLUMN IF NOT EXISTS channel_title text;

COMMENT ON COLUMN channel_videos.channel_id IS
  'YouTube channel this video belongs to. Populated at sync time; null for rows written before this column existed.';
COMMENT ON COLUMN channel_videos.channel_title IS
  'YouTube channel display name, for the My Videos channel filter.';

-- Supports "which channels has this creator brought in videos from, and how many
-- unanalyzed videos does each have" — the query behind the My Videos channel filter.
CREATE INDEX IF NOT EXISTS idx_channel_videos_creator_channel
  ON channel_videos (creator_id, channel_id)
  WHERE channel_id IS NOT NULL;
