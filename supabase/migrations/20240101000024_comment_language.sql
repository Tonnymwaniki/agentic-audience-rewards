-- Migration: comment language, and a language filter for comment search
-- Run this in your Supabase SQL editor. Requires 20240101000023.
--
-- Safe to run before or after the matching code deploys:
--   * Categorization writes language only once the column exists (it retries
--     without it until then), and Research tools read it only once it exists.
--   * search_comments sends p_language only when a language filter is used; until
--     these functions exist it falls back to a search that applies the filter in
--     application code.

BEGIN;

-- 1. The comment's language, detected in the same batched categorization call:
--    'english' | 'swahili' | 'sheng' | 'mixed' (code-switched between two or more),
--    or NULL when there is no language to detect (emoji-only) or it isn't one of
--    these. Free text rather than an enum, like escalation_flag, so a value can be
--    added without a migration. Existing rows are filled by
--    scripts/backfill-comment-language.ts.
ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS language text;

-- 2. Rebuild the search functions with a p_language filter. DROP first for the same
--    reason as migration 23: adding an argument would otherwise leave an overload
--    that PostgREST can't choose between.
DROP FUNCTION IF EXISTS public.search_comments_semantic(uuid, vector, int, uuid, text, timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS public.search_comments_keyword(uuid, text, int, uuid, text, timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS public.search_comments_filtered(uuid, int, uuid, text, timestamptz, timestamptz, text);

-- Filter semantics are unchanged from migration 23, plus:
--   p_language  exact match on comment_categories.language
CREATE OR REPLACE FUNCTION public.search_comments_semantic(
  p_creator_id uuid,
  p_query_embedding vector,
  p_limit int DEFAULT 50,
  p_post_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_posted_from timestamptz DEFAULT NULL,
  p_posted_before timestamptz DEFAULT NULL,
  p_sentiment text DEFAULT NULL,
  p_language text DEFAULT NULL
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
      AND (p_language IS NULL OR cc.language = p_language)
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
  p_sentiment text DEFAULT NULL,
  p_language text DEFAULT NULL
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
      AND (p_language IS NULL OR cc.language = p_language)
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
  p_sentiment text DEFAULT NULL,
  p_language text DEFAULT NULL
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
      AND (p_language IS NULL OR cc.language = p_language)
  )
  SELECT matched.id, count(*) OVER () AS total_matches
  FROM matched
  ORDER BY matched.posted_at DESC NULLS LAST, matched.id
  LIMIT p_limit;
$$;

-- Only the service role (authenticated routes that derive p_creator_id from the
-- session) may call these.
REVOKE ALL ON FUNCTION public.search_comments_semantic(uuid, vector, int, uuid, text, timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_comments_keyword(uuid, text, int, uuid, text, timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_comments_filtered(uuid, int, uuid, text, timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_comments_semantic(uuid, vector, int, uuid, text, timestamptz, timestamptz, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_comments_keyword(uuid, text, int, uuid, text, timestamptz, timestamptz, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_comments_filtered(uuid, int, uuid, text, timestamptz, timestamptz, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
