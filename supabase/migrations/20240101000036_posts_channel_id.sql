-- Which YouTube channel each post belongs to.
--
-- Needed by capability gating (lib/channel-verification.ts): drafting replies and
-- evaluating rewards require a verified OAuth grant for THAT post's channel, and
-- until now nothing recorded which channel a post came from. The gate falls back
-- to a YouTube lookup when this is null, so it works without this migration — this
-- column just makes the check a local read instead of a network round trip.
--
-- Nullable on purpose: posts ingested before this existed have no value until the
-- backfill (scripts/backfill-post-channel-id.ts) or the first gate check fills it.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS channel_id text;

-- Supports "which of this creator's posts belong to a verified channel?", which is
-- the query the My Videos verification banner runs.
CREATE INDEX IF NOT EXISTS idx_posts_creator_channel
  ON posts (creator_id, channel_id)
  WHERE channel_id IS NOT NULL;

COMMENT ON COLUMN posts.channel_id IS
  'YouTube channel that owns this video, from snippet.channelId. Used to gate drafting and rewards on verified ownership.';
