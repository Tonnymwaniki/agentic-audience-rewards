-- Migration: per-comment like counts, and date-range + sentiment filters for comment search
-- Run this in your Supabase SQL editor. Requires 20240101000020 (hybrid comment search).
--
-- Safe to run before or after the matching code deploys:
--   * Ingestion writes like_count only once the column exists (it retries without
--     it until then).
--   * Research chat's search_comments sends the new filter arguments only when a
--     filter is used; until these functions exist it falls back to a search that
--     applies the same filters in application code, so results are never silently
--     unfiltered.

BEGIN;

-- 1. Per-comment like counts, from YouTube's commentThreads.list likeCount.
--
-- Existing rows start at 0 until scripts/backfill-comment-likes.ts re-fetches them.
ALTER TABLE comments ADD COLUMN IF NOT EXISTS like_count int DEFAULT 0;

-- 2. Filters on posted_at, which the date filters below read.
CREATE INDEX IF NOT EXISTS comments_post_posted_at_idx ON comments (post_id, posted_at DESC);

-- 3. Replace the candidate functions with versions that also filter by date and
--    sentiment.
--
-- DROP first, rather than CREATE OR REPLACE: adding arguments creates a second
-- overload next to the old one, and PostgREST then fails to choose between them
-- ("could not choose the best candidate function") for calls that only use the
-- shared arguments.
DROP FUNCTION IF EXISTS public.search_comments_semantic(uuid, vector, int, uuid, text);
DROP FUNCTION IF EXISTS public.search_comments_keyword(uuid, text, int, uuid, text);

-- Shared filter semantics, identical in all three functions:
--   p_posted_from    inclusive lower bound on comments.posted_at
--   p_posted_before  EXCLUSIVE upper bound (the app turns a date_to day into the
--                    start of the following day, so that whole day is included)
--   p_sentiment      the derived sentiment used everywhere else in the app
--                    (lib/trending.ts computeSentiment): praise = positive,
--                    complaint = negative, any other category = neutral. A comment
--                    with no category yet has no sentiment and matches none of them,
--                    exactly as computeSentiment skips it.
CREATE OR REPLACE FUNCTION public.search_comments_semantic(
  p_creator_id uuid,
  p_query_embedding vector,
  p_limit int DEFAULT 50,
  p_post_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_posted_from timestamptz DEFAULT NULL,
  p_posted_before timestamptz DEFAULT NULL,
  p_sentiment text DEFAULT NULL
)
RETURNS TABLE (id uuid, similarity double precision)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
  -- MATERIALIZED forces the creator filter to run first, so the ORDER BY below is
  -- an exact search over this creator's rows rather than a filtered HNSW scan.
  WITH scoped AS MATERIALIZED (
    SELECT c.id, c.embedding
    FROM comments c
    JOIN posts p ON p.id = c.post_id
    LEFT JOIN comment_categories cc ON cc.comment_id = c.id
    WHERE p.creator_id = p_creator_id
      AND c.embedding IS NOT NULL
      AND (p_post_id IS NULL OR c.post_id = p_post_id)
      AND (p_category IS NULL OR cc.category = p_category)
      AND (p_posted_from IS NULL OR c.posted_at >= p_posted_from)
      AND (p_posted_before IS NULL OR c.posted_at < p_posted_before)
      AND (
        p_sentiment IS NULL
        OR (p_sentiment = 'positive' AND cc.category = 'praise')
        OR (p_sentiment = 'negative' AND cc.category = 'complaint')
        OR (p_sentiment = 'neutral' AND cc.category IS NOT NULL AND cc.category NOT IN ('praise', 'complaint'))
      )
  )
  SELECT scoped.id, 1 - (scoped.embedding <=> p_query_embedding) AS similarity
  FROM scoped
  ORDER BY scoped.embedding <=> p_query_embedding
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION public.search_comments_keyword(
  p_creator_id uuid,
  p_query text,
  p_limit int DEFAULT 50,
  p_post_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_posted_from timestamptz DEFAULT NULL,
  p_posted_before timestamptz DEFAULT NULL,
  p_sentiment text DEFAULT NULL
)
RETURNS TABLE (id uuid, rank real, total_matches bigint)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
  WITH q AS (
    SELECT websearch_to_tsquery('english', p_query) AS tsq
  ),
  matched AS (
    SELECT c.id, ts_rank_cd(c.text_search, q.tsq) AS rank
    FROM comments c
    JOIN posts p ON p.id = c.post_id
    LEFT JOIN comment_categories cc ON cc.comment_id = c.id
    CROSS JOIN q
    WHERE p.creator_id = p_creator_id
      AND c.text_search @@ q.tsq
      AND (p_post_id IS NULL OR c.post_id = p_post_id)
      AND (p_category IS NULL OR cc.category = p_category)
      AND (p_posted_from IS NULL OR c.posted_at >= p_posted_from)
      AND (p_posted_before IS NULL OR c.posted_at < p_posted_before)
      AND (
        p_sentiment IS NULL
        OR (p_sentiment = 'positive' AND cc.category = 'praise')
        OR (p_sentiment = 'negative' AND cc.category = 'complaint')
        OR (p_sentiment = 'neutral' AND cc.category IS NOT NULL AND cc.category NOT IN ('praise', 'complaint'))
      )
  )
  SELECT matched.id, matched.rank, count(*) OVER () AS total_matches
  FROM matched
  ORDER BY matched.rank DESC, matched.id
  LIMIT p_limit;
$$;

-- Filter-only listing, for questions with no search words ("what negative
-- comments came in during the last 2 weeks?"). Newest first, plus the total
-- number of comments matching the filters.
CREATE OR REPLACE FUNCTION public.search_comments_filtered(
  p_creator_id uuid,
  p_limit int DEFAULT 20,
  p_post_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_posted_from timestamptz DEFAULT NULL,
  p_posted_before timestamptz DEFAULT NULL,
  p_sentiment text DEFAULT NULL
)
RETURNS TABLE (id uuid, total_matches bigint)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
  WITH matched AS (
    SELECT c.id, c.posted_at
    FROM comments c
    JOIN posts p ON p.id = c.post_id
    LEFT JOIN comment_categories cc ON cc.comment_id = c.id
    WHERE p.creator_id = p_creator_id
      AND (p_post_id IS NULL OR c.post_id = p_post_id)
      AND (p_category IS NULL OR cc.category = p_category)
      AND (p_posted_from IS NULL OR c.posted_at >= p_posted_from)
      AND (p_posted_before IS NULL OR c.posted_at < p_posted_before)
      AND (
        p_sentiment IS NULL
        OR (p_sentiment = 'positive' AND cc.category = 'praise')
        OR (p_sentiment = 'negative' AND cc.category = 'complaint')
        OR (p_sentiment = 'neutral' AND cc.category IS NOT NULL AND cc.category NOT IN ('praise', 'complaint'))
      )
  )
  SELECT matched.id, count(*) OVER () AS total_matches
  FROM matched
  ORDER BY matched.posted_at DESC NULLS LAST, matched.id
  LIMIT p_limit;
$$;

-- Same lockdown as migration 20: these trust p_creator_id, so only the service
-- role (used by authenticated routes that derive it from the session) may call them.
REVOKE ALL ON FUNCTION public.search_comments_semantic(uuid, vector, int, uuid, text, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_comments_keyword(uuid, text, int, uuid, text, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_comments_filtered(uuid, int, uuid, text, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_comments_semantic(uuid, vector, int, uuid, text, timestamptz, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_comments_keyword(uuid, text, int, uuid, text, timestamptz, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_comments_filtered(uuid, int, uuid, text, timestamptz, timestamptz, text) TO service_role;

-- PostgREST caches function signatures; reload so the new ones are callable at once.
NOTIFY pgrst, 'reload schema';

COMMIT;
