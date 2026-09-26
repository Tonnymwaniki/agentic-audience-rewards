-- Migration 40: archive the raw YouTube API object behind every comment and video.
--
-- Insurance for fields we don't extract into columns today: the complete,
-- unmodified item as YouTube returned it (commentThreads.list item for a top-level
-- comment, comments.list item for a reply, videos.list item for a video). Write-only
-- for now — nothing reads it, and no query selects it implicitly (no select('*') on
-- these tables). Re-ingesting a video overwrites it with the latest response, the
-- same way the extracted counts are refreshed.

ALTER TABLE comments ADD COLUMN IF NOT EXISTS raw_api_response jsonb;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS raw_api_response jsonb;
