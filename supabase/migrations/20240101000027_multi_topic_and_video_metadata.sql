-- Migration: multiple topics per comment, and richer video metadata
-- Run this in your Supabase SQL editor. Requires 20240101000026.
--
-- Safe to run before or after the matching code deploys: categorization and
-- ingestion write each new column only once it exists (they retry without it until
-- then), and every reader falls back to the single `topic` column.

BEGIN;

-- 1. Every topic a comment covers, most important first. `topic` stays populated
--    with topics[1] so anything still reading a single topic keeps working.
--
--    Counting note: a comment tagged "price" and "delivery" counts toward BOTH
--    themes. Theme counts are therefore MENTIONS and can add up to more than the
--    number of comments; the totals used for trends and shares still count each
--    comment once.
ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS topics text[];

-- Finds "which comments mention this topic" without scanning every row.
CREATE INDEX IF NOT EXISTS comment_categories_topics_idx ON comment_categories USING GIN (topics);

-- 2. Video length and YouTube's own category, from videos.list contentDetails and
--    snippet.categoryId. duration_seconds is the ISO 8601 duration (PT15M33S)
--    parsed to seconds; youtube_category is the readable name ("Entertainment")
--    when videoCategories.list resolves it, else the raw id.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS duration_seconds int;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS youtube_category text;

NOTIFY pgrst, 'reload schema';

COMMIT;
