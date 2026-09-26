-- Migration 43: proactive Insight Agent (lib/insight-agent.ts).
--
-- After the daily audience_insights refresh, themes whose trend swings sharply are
-- judged by Claude and, when genuinely notable, sent to the creator's inbox as a
-- notification. surfaced_insights records what was sent so an ongoing trend isn't
-- re-notified every day (the agent skips a theme surfaced for that creator in the
-- last 7 days).

CREATE TABLE IF NOT EXISTS surfaced_insights (
  id uuid primary key default gen_random_uuid(),
  -- ON DELETE CASCADE (added to the spec'd DDL): without it, deleting a creator's
  -- account would fail on this foreign key.
  creator_id uuid references creators(id) on delete cascade not null,
  theme text not null,
  trend_pct numeric,
  surfaced_at timestamptz default now(),
  unique(creator_id, theme, surfaced_at)
);

-- The agent's only query: "was this theme surfaced for this creator recently?"
CREATE INDEX IF NOT EXISTS surfaced_insights_lookup_idx
  ON surfaced_insights (creator_id, theme, surfaced_at DESC);

-- Written and read only by the daily job (service role). RLS on with no policies,
-- so it is not readable or writable through the public API.
ALTER TABLE surfaced_insights ENABLE ROW LEVEL SECURITY;

-- An insight notification is about a theme, not one comment. Every existing row
-- has a comment, and the comment-based notifications still always set it.
ALTER TABLE notifications ALTER COLUMN comment_id DROP NOT NULL;
