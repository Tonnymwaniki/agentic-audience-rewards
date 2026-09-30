-- Migration: on-demand YouTube channel enrichment for audience_members (Phase 5
-- of the Audience Profiles concept — see app/dashboard/audience/[memberId]/page.tsx).
--
-- This is deliberately separate from segment/level/profile_summary: those are
-- computed for free from comments already ingested. These columns instead cache
-- the result of a channels.list call against the COMMENTER's own channel
-- (audience_members.external_id), which costs YouTube API quota and is only ever
-- fetched lazily, one profile at a time, when a creator opens that person's page
-- and asks for it — never in bulk, and never automatically during ingestion.
--
-- YouTube's public channel data never includes a real name or email or location —
-- those are not exposed by the API regardless of quota spent. What's genuinely
-- available and useful here is: their channel's own display name/avatar (already
-- stored via display_name/profile_image_url from comment ingestion), their bio,
-- subscriber/video counts, and how long their channel has existed — all public,
-- all self-published by that person on their own channel.

ALTER TABLE audience_members ADD COLUMN IF NOT EXISTS channel_bio text;
ALTER TABLE audience_members ADD COLUMN IF NOT EXISTS channel_subscriber_count bigint;
ALTER TABLE audience_members ADD COLUMN IF NOT EXISTS channel_video_count integer;
ALTER TABLE audience_members ADD COLUMN IF NOT EXISTS channel_created_at timestamptz;

-- When this cache was last (attempted to be) filled. Null = never tried. Checked
-- before spending quota again, and also doubles as "tried and found nothing" (a
-- private/deleted commenter channel) so that case doesn't retry on every page view.
ALTER TABLE audience_members ADD COLUMN IF NOT EXISTS channel_enriched_at timestamptz;
