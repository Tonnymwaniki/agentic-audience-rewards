-- Extra YouTube fields captured from calls the app already makes.
--
-- Everything here arrives in responses we were already requesting, or needs only
-- an extra `part` on videos.list / channels.list — which does not change the quota
-- cost (1 unit per call whatever the parts). No new OAuth scope; all of it is
-- public data readable with the existing API key.
--
-- Every column is nullable and the ingest code drops any column the database
-- rejects as unknown, so deploying the code before this migration keeps ingesting.

BEGIN;

-- --- comments -----------------------------------------------------------------

-- YouTube's snippet.updatedAt. Deliberately NOT named plain `updated_at`: that
-- name conventionally means "when this ROW changed", and a reader would reasonably
-- assume a trigger maintains it. This is when the COMMENTER last edited the text.
ALTER TABLE comments ADD COLUMN IF NOT EXISTS youtube_updated_at timestamptz;

-- YouTube sets updatedAt equal to publishedAt for a comment that was never edited,
-- so "edited" is derivable rather than something to keep in sync by hand.
-- Generated, so it can never disagree with the timestamps it is computed from.
ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_edited boolean
  GENERATED ALWAYS AS (youtube_updated_at IS NOT NULL AND youtube_updated_at > posted_at) STORED;

-- --- audience_members (commenter profile picture) -------------------------------

-- On the MEMBER, not the comment: a profile picture belongs to the person, and
-- per-comment storage would repeat the same URL on every comment they have left
-- and let those copies drift apart. Refreshed on each ingest.
--
-- PRIVACY: this is public on YouTube, but it is identifying. It must never be
-- rendered on the public /recognized page, which anonymizes commenters.
ALTER TABLE audience_members ADD COLUMN IF NOT EXISTS profile_image_url text;

-- --- posts ----------------------------------------------------------------------

ALTER TABLE posts ADD COLUMN IF NOT EXISTS tags text[];

-- contentDetails.caption: whether the uploader published captions. It does NOT
-- cover YouTube's auto-generated captions, which are not reported by the API.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS has_captions boolean;

-- YouTube's own public comment count (statistics.commentCount). Distinct from
-- comments_total, which counts what WE ingested — replies included, and capped.
-- This is the honest denominator-side figure for engagement rate.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS youtube_comment_count bigint;

-- liveStreamingDetails. All null for an ordinary upload; populated for streams and
-- premieres. Scheduled times can exist without actual times (a stream that never
-- went live), which is why they are kept separately rather than collapsed.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS live_scheduled_start_at timestamptz;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS live_scheduled_end_at timestamptz;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS live_actual_start_at timestamptz;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS live_actual_end_at timestamptz;

-- --- creators (channel) ---------------------------------------------------------

ALTER TABLE creators ADD COLUMN IF NOT EXISTS channel_created_at timestamptz;

-- snippet.country: the country the channel OWNER set in their YouTube settings.
-- Optional and self-declared — often null, and not a statement about where the
-- audience is.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS channel_country text;

NOTIFY pgrst, 'reload schema';

COMMIT;
