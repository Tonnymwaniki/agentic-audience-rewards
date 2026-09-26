-- Migration 45: embeddings for named entities and business-profile facts, so
-- Research can match them by meaning, not just wording (lib/knowledge-embeddings.ts).
-- Separate from the comment embeddings (comments.embedding), which are unchanged.
--
-- Same model and size as comment embeddings: Voyage voyage-4, 1024 dimensions.
-- Similarity is computed in application code over one creator's rows — a creator
-- has tens of entities and at most ~15 facts — so no vector index or SQL search
-- function is needed, and nothing new is exposed through the API.
-- Both tables: RLS on with no policies (service role only); rows go with the
-- creator (ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS entity_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  -- entityKey() of the canonical name (lib/entities.ts), after the creator's aliases.
  entity_key text NOT NULL,
  entity_name text NOT NULL,
  -- What was embedded: the name plus aggregated context from the comments naming it.
  context text NOT NULL,
  -- Mentions when embedded; the context is refreshed once mentions double.
  mention_count integer NOT NULL,
  embedding vector(1024) NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, entity_key)
);

CREATE TABLE IF NOT EXISTS profile_fact_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  -- 'fixed' = a creators column (delivery_info, business_hours, ...);
  -- 'custom' = a custom_profile_fields row.
  source text NOT NULL CHECK (source IN ('fixed', 'custom')),
  field_key text NOT NULL,
  field_label text NOT NULL,
  -- What was embedded: "Label: value". Compared on sync to re-embed only changes.
  content text NOT NULL,
  embedding vector(1024) NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, source, field_key)
);

ALTER TABLE entity_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_fact_embeddings ENABLE ROW LEVEL SECURITY;
