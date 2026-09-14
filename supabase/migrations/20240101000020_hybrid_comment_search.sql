-- Migration: hybrid comment search (full-text + vector similarity)
-- Run this in your Supabase SQL editor. Requires 20240101000019 (pgvector + comments.embedding).
--
-- Safe to run before or after the matching code deploys: until these functions
-- exist, Research chat's search_comments falls back to its old substring search.

-- 1. Full-text search column + index.
--
-- Generated and STORED, so it stays in sync with comments.text automatically and
-- ingestion never has to write it. 'english' stems English words ("prices" and
-- "price" match); Swahili and Sheng words pass through unstemmed, which is why the
-- vector side exists for this audience.
ALTER TABLE comments ADD COLUMN IF NOT EXISTS text_search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

CREATE INDEX IF NOT EXISTS comments_text_search_idx ON comments USING GIN (text_search);

-- 2. Vector similarity index.
--
-- Note: search_comments_semantic below deliberately does NOT use this index. HNSW
-- finds nearest neighbours across ALL creators and only then applies the creator
-- filter, so a creator-scoped query can silently come back short or wrong (with
-- two creators splitting the data roughly 50/50, about half the candidates are
-- discarded). Exact search over one creator's comments is a few milliseconds at
-- this scale and has perfect recall. The index serves any future unscoped
-- similarity query, and is cheap to keep.
CREATE INDEX IF NOT EXISTS comments_embedding_idx ON comments USING hnsw (embedding vector_cosine_ops);

-- 3. Candidate functions for lib/hybrid-search.ts, which fuses the two rankings.
--
-- Both take a creator_id, which makes them dangerous if exposed: PostgREST lets
-- anyone holding the anon key call public functions, and a caller-chosen
-- creator_id would read another creator's comments. EXECUTE is therefore revoked
-- from everyone except service_role, and the app only calls them from
-- authenticated routes that derive creator_id from the session.

-- Semantic candidates: nearest comments to a query embedding, within one creator.
CREATE OR REPLACE FUNCTION public.search_comments_semantic(
  p_creator_id uuid,
  p_query_embedding vector,
  p_limit int DEFAULT 50,
  p_post_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL
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
  )
  SELECT scoped.id, 1 - (scoped.embedding <=> p_query_embedding) AS similarity
  FROM scoped
  ORDER BY scoped.embedding <=> p_query_embedding
  LIMIT p_limit;
$$;

-- Keyword candidates: full-text matches within one creator, best first, plus the
-- total match count (the honest answer to "how many comments mention X").
--
-- websearch_to_tsquery rather than to_tsquery: to_tsquery raises a syntax error on
-- ordinary text like "how much?", and this receives free text from the model.
CREATE OR REPLACE FUNCTION public.search_comments_keyword(
  p_creator_id uuid,
  p_query text,
  p_limit int DEFAULT 50,
  p_post_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL
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
  )
  SELECT matched.id, matched.rank, count(*) OVER () AS total_matches
  FROM matched
  ORDER BY matched.rank DESC, matched.id
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.search_comments_semantic(uuid, vector, int, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_comments_keyword(uuid, text, int, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_comments_semantic(uuid, vector, int, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_comments_keyword(uuid, text, int, uuid, text) TO service_role;
