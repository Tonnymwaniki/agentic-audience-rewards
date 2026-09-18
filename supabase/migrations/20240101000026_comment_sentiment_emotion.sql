-- Migration: real per-comment sentiment and emotion
-- Run this in your Supabase SQL editor. Requires 20240101000024.
--
-- Sentiment was previously DERIVED from the intent category (praise = positive,
-- complaint = negative, everything else neutral). These columns hold the classifier's
-- own judgment, made in the same batched call as the category, so a question can be
-- negative and a complaint can be sarcastic.
--
-- Safe to run before or after the matching code deploys: categorization writes these
-- only once the columns exist, readers fall back to the derived approximation for
-- comments that have none, and search sends p_emotion only when a filter uses it.

BEGIN;

-- 'positive' | 'negative' | 'neutral' | 'mixed'. NULL means "not classified yet" —
-- readers then fall back to the category-derived value.
ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS sentiment text;

-- The single strongest emotion: anger, joy, sadness, frustration, excitement,
-- confusion, sarcasm, disappointment, admiration, fear, or 'none'. Free text rather
-- than an enum, like escalation_flag and language, so a value can be added later.
ALTER TABLE comment_categories ADD COLUMN IF NOT EXISTS emotion text;

-- Rebuild the search functions to filter on the real values, with the derived
-- fallback, and to accept an emotion filter. DROP first for the same reason as
-- migrations 23-24: an added argument would otherwise leave an ambiguous overload.
DROP FUNCTION IF EXISTS public.search_comments_semantic(uuid, vector, int, uuid, text, timestamptz, timestamptz, text, text);
DROP FUNCTION IF EXISTS public.search_comments_keyword(uuid, text, int, uuid, text, timestamptz, timestamptz, text, text);
DROP FUNCTION IF EXISTS public.search_comments_filtered(uuid, int, uuid, text, timestamptz, timestamptz, text, text);

-- Filter semantics are unchanged from migration 24, plus:
--   p_sentiment  now matches comment_categories.sentiment when it is set, and the
--                category-derived value only when it is NULL
--   p_emotion    exact match on comment_categories.emotion
CREATE OR REPLACE FUNCTION public.search_comments_semantic(
  p_creator_id uuid,
  p_query_embedding vector,
  p_limit int DEFAULT 50,
  p_post_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_posted_from timestamptz DEFAULT NULL,
  p_posted_before timestamptz DEFAULT NULL,
  p_sentiment text DEFAULT NULL,
  p_language text DEFAULT NULL,
  p_emotion text DEFAULT NULL
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
        -- Real, classified sentiment when the comment has been categorized since
        -- migration 20240101000026; the old category-derived approximation only for
        -- comments that have not. 'mixed' exists only as a real value.
        OR (cc.sentiment IS NOT NULL AND cc.sentiment = p_sentiment)
        OR (
          cc.sentiment IS NULL
          AND (
            (p_sentiment = 'positive' AND cc.category = 'praise')
            OR (p_sentiment = 'negative' AND cc.category = 'complaint')
            OR (p_sentiment = 'neutral' AND cc.category IS NOT NULL AND cc.category NOT IN ('praise', 'complaint'))
          )
        )
      )
      AND (p_emotion IS NULL OR cc.emotion = p_emotion)
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
  p_language text DEFAULT NULL,
  p_emotion text DEFAULT NULL
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
        -- Real, classified sentiment when the comment has been categorized since
        -- migration 20240101000026; the old category-derived approximation only for
        -- comments that have not. 'mixed' exists only as a real value.
        OR (cc.sentiment IS NOT NULL AND cc.sentiment = p_sentiment)
        OR (
          cc.sentiment IS NULL
          AND (
            (p_sentiment = 'positive' AND cc.category = 'praise')
            OR (p_sentiment = 'negative' AND cc.category = 'complaint')
            OR (p_sentiment = 'neutral' AND cc.category IS NOT NULL AND cc.category NOT IN ('praise', 'complaint'))
          )
        )
      )
      AND (p_emotion IS NULL OR cc.emotion = p_emotion)
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
  p_language text DEFAULT NULL,
  p_emotion text DEFAULT NULL
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
        -- Real, classified sentiment when the comment has been categorized since
        -- migration 20240101000026; the old category-derived approximation only for
        -- comments that have not. 'mixed' exists only as a real value.
        OR (cc.sentiment IS NOT NULL AND cc.sentiment = p_sentiment)
        OR (
          cc.sentiment IS NULL
          AND (
            (p_sentiment = 'positive' AND cc.category = 'praise')
            OR (p_sentiment = 'negative' AND cc.category = 'complaint')
            OR (p_sentiment = 'neutral' AND cc.category IS NOT NULL AND cc.category NOT IN ('praise', 'complaint'))
          )
        )
      )
      AND (p_emotion IS NULL OR cc.emotion = p_emotion)
      AND (p_language IS NULL OR cc.language = p_language)
  )
  SELECT matched.id, count(*) OVER () AS total_matches
  FROM matched
  ORDER BY matched.posted_at DESC NULLS LAST, matched.id
  LIMIT p_limit;
$$;

-- Only the service role (authenticated routes that derive p_creator_id from the
-- session) may call these.
REVOKE ALL ON FUNCTION public.search_comments_semantic(uuid, vector, int, uuid, text, timestamptz, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_comments_keyword(uuid, text, int, uuid, text, timestamptz, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_comments_filtered(uuid, int, uuid, text, timestamptz, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_comments_semantic(uuid, vector, int, uuid, text, timestamptz, timestamptz, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_comments_keyword(uuid, text, int, uuid, text, timestamptz, timestamptz, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_comments_filtered(uuid, int, uuid, text, timestamptz, timestamptz, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
