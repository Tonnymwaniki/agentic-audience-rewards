-- Migration: daily cache for Research's Content Ideas page
-- Run this in your Supabase SQL editor.
--
-- The ideas page costs one model call. Instead of making it on every visit, the
-- last successful generation is stored here (one row per creator) and reused for
-- 24 hours, or until the creator asks to regenerate. Failed or rejected
-- generations are never written, so this only ever holds a trustworthy result.

CREATE TABLE IF NOT EXISTS content_ideas_cache (
  creator_id uuid PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  -- The rendered ideas, each with the real comment signals it was based on.
  ideas jsonb NOT NULL,
  -- How many questions / buying signals / content requests / repeated comments
  -- the ideas were drawn from, for the page subtitle.
  signal_counts jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS on with no policies: only the service role (the authenticated Research
-- report page) can read or write this table. The anon key gets nothing.
ALTER TABLE content_ideas_cache ENABLE ROW LEVEL SECURITY;
