-- Migration: audience segments
-- Run this in your Supabase SQL editor. Requires 20240101000026.
--
-- A person's segment is computed from their own aggregate comment history by fixed,
-- explainable rules (lib/segments.ts) — no per-person AI guessing — and refreshed
-- whenever their audience-memory profile is refreshed.
--
-- Safe to run before or after the matching code deploys: the segment is written only
-- once the column exists, and search sends p_segment only when a filter uses it.

BEGIN;

-- One of: potential_customer | critic | loyal_fan | content_requester | casual_viewer.
-- NULL means "not computed yet"; readers treat that as unsegmented rather than casual.
ALTER TABLE audience_members ADD COLUMN IF NOT EXISTS segment text;

-- The read pattern this adds: "this creator's people in segment X".
CREATE INDEX IF NOT EXISTS audience_members_creator_segment_idx ON audience_members (creator_id, segment);

-- Rebuild the search functions with a p_segment filter, joining the commenter's
-- audience_members row. DROP first for the same reason as migrations 23-26: an added
-- argument would otherwise leave an ambiguous overload.
DROP FUNCTION IF EXISTS public.search_comments_semantic(uuid, vector, int, uuid, text, timestamptz, timestamptz, text, text, text);
DROP FUNCTION IF EXISTS public.search_comments_keyword(uuid, text, int, uuid, text, timestamptz, timestamptz, text, text, text);
DROP FUNCTION IF EXISTS public.search_comments_filtered(uuid, int, uuid, text, timestamptz, timestamptz, text, text, text);

-- Filter semantics are unchanged from migration 26, plus:
--   p_segment  exact match on the commenter's audience_members.segment
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
  p_emotion text DEFAULT NULL,
  p_segment text DEFAULT NULL
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
    LEFT JOIN audience_members am ON am.id = c.audience_member_id
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
      AND (p_segment IS NULL OR am.segment = p_segment)
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
  p_emotion text DEFAULT NULL,
  p_segment text DEFAULT NULL
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
    LEFT JOIN audience_members am ON am.id = c.audience_member_id
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
      AND (p_segment IS NULL OR am.segment = p_segment)
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
  p_emotion text DEFAULT NULL,
  p_segment text DEFAULT NULL
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
    LEFT JOIN audience_members am ON am.id = c.audience_member_id
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
      AND (p_segment IS NULL OR am.segment = p_segment)
  )
  SELECT matched.id, count(*) OVER () AS total_matches
  FROM matched
  ORDER BY matched.posted_at DESC NULLS LAST, matched.id
  LIMIT p_limit;
$$;

-- Only the service role (authenticated routes that derive p_creator_id from the
-- session) may call these.
REVOKE ALL ON FUNCTION public.search_comments_semantic(uuid, vector, int, uuid, text, timestamptz, timestamptz, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_comments_keyword(uuid, text, int, uuid, text, timestamptz, timestamptz, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_comments_filtered(uuid, int, uuid, text, timestamptz, timestamptz, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_comments_semantic(uuid, vector, int, uuid, text, timestamptz, timestamptz, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_comments_keyword(uuid, text, int, uuid, text, timestamptz, timestamptz, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_comments_filtered(uuid, int, uuid, text, timestamptz, timestamptz, text, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
