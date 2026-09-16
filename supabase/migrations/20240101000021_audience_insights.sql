-- Migration: precomputed audience insights
-- Run this in your Supabase SQL editor.
--
-- Filled daily by /api/cron/compute-insights and read by Research chat's
-- get_audience_insights tool, so answers about what the audience talks about come
-- from one consistent daily computation instead of being rebuilt on every question.
--
-- "topic" is a THEME, not a raw comment_categories.topic value. Raw topics are too
-- fragmented to summarise (464 distinct values across 684 comments for one creator,
-- 384 of them used once), so lib/audience-insights.ts groups them by head word:
-- content_quality, video_quality and show_quality all become "quality".

CREATE TABLE IF NOT EXISTS audience_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  topic text NOT NULL,
  comment_count integer NOT NULL,
  -- Percentages summing to 100, derived from comment categories (praise = positive,
  -- complaint = negative, everything else neutral), plus the total they came from.
  sentiment_breakdown jsonb NOT NULL,
  -- Change in this theme's SHARE of all comments, last 30 days vs the 30 before.
  trend_direction text NOT NULL
    CHECK (trend_direction IN ('rising', 'falling', 'stable', 'new', 'insufficient_data')),
  trend_pct numeric,
  representative_comment_ids uuid[] NOT NULL DEFAULT '{}',
  related_post_ids uuid[] NOT NULL DEFAULT '{}',
  confidence numeric NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- The only read pattern: one creator's latest set, biggest themes first.
CREATE INDEX IF NOT EXISTS audience_insights_creator_idx
  ON audience_insights (creator_id, computed_at DESC, comment_count DESC);

-- RLS on with no policies: only the service role (the cron job and the
-- authenticated Research route) can read or write this table. The anon key gets
-- nothing, which is the safe default for per-creator data.
ALTER TABLE audience_insights ENABLE ROW LEVEL SECURITY;
