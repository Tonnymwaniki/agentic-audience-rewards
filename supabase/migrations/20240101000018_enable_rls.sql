-- Migration: Row Level Security across the full schema (defense in depth)
-- Run this in your Supabase SQL editor.
--
-- READ THIS BEFORE RUNNING — this migration is NOT purely additive.
--
-- The application does not reach the database exclusively through the
-- service-role key. lib/supabase/server.ts and lib/supabase/client.ts both use
-- the ANON key, and twelve server components read through them (My Videos,
-- Rewards, Agent Home, Research, Highlights, Brain, Me, the post detail page,
-- and others). Those reads carry the signed-in user's JWT, so they are subject
-- to every policy below. If a policy is wrong, those pages return empty rather
-- than erroring — a silent failure, not a loud one.
--
-- One code change is REQUIRED BEFORE this runs: app/claim/[token]/page.tsx read
-- reward_events with the anon key as an ANONYMOUS visitor (a public claim link,
-- no session). No creator-scoped policy can permit that, so the page has been
-- switched to the service-role client. Deploy that change first, or every claim
-- link 404s the moment RLS is enabled.
--
-- Service-role connections bypass RLS entirely, so every route under app/api/
-- is unaffected.

-- ---------------------------------------------------------------------------
-- Helper: the creator row belonging to the current user.
--
-- SECURITY DEFINER so it reads `creators` without re-entering that table's own
-- policy — a policy on creators that queried creators would recurse. STABLE so
-- the planner evaluates it once per statement rather than once per row, which
-- matters because these policies sit under reads of thousands of comments.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_creator_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM creators WHERE user_id = auth.uid()
$$;

REVOKE ALL ON FUNCTION public.current_creator_id() FROM public;
GRANT EXECUTE ON FUNCTION public.current_creator_id() TO authenticated;

-- Indexes on the columns the policy subqueries filter by. Without these, RLS
-- turns each row read into a sequential scan of the parent table.
CREATE INDEX IF NOT EXISTS posts_creator_idx ON posts (creator_id);
CREATE INDEX IF NOT EXISTS comments_post_idx ON comments (post_id);
CREATE INDEX IF NOT EXISTS comment_categories_comment_idx ON comment_categories (comment_id);
CREATE INDEX IF NOT EXISTS audience_members_creator_idx ON audience_members (creator_id);
CREATE INDEX IF NOT EXISTS reward_events_member_idx ON reward_events (audience_member_id);
CREATE INDEX IF NOT EXISTS channel_videos_creator_idx ON channel_videos (creator_id);
CREATE INDEX IF NOT EXISTS tracked_videos_creator_idx ON tracked_videos (creator_id);

-- ---------------------------------------------------------------------------
-- creators — the root of every ownership chain. Matched on user_id directly
-- rather than through the helper, since this IS what the helper resolves.
-- ---------------------------------------------------------------------------
ALTER TABLE creators ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS creators_own_row ON creators;
CREATE POLICY creators_own_row ON creators
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- posts — creator_id is direct.
-- ---------------------------------------------------------------------------
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS posts_own_creator ON posts;
CREATE POLICY posts_own_creator ON posts
  FOR ALL TO authenticated
  USING (creator_id = public.current_creator_id())
  WITH CHECK (creator_id = public.current_creator_id());

-- ---------------------------------------------------------------------------
-- comments — reached through posts.
-- ---------------------------------------------------------------------------
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comments_own_creator ON comments;
CREATE POLICY comments_own_creator ON comments
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM posts
      WHERE posts.id = comments.post_id
        AND posts.creator_id = public.current_creator_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM posts
      WHERE posts.id = comments.post_id
        AND posts.creator_id = public.current_creator_id()
    )
  );

-- ---------------------------------------------------------------------------
-- comment_categories — reached through comments -> posts. Note this table is
-- keyed by comment_id and has no id column of its own.
-- ---------------------------------------------------------------------------
ALTER TABLE comment_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comment_categories_own_creator ON comment_categories;
CREATE POLICY comment_categories_own_creator ON comment_categories
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM comments
      JOIN posts ON posts.id = comments.post_id
      WHERE comments.id = comment_categories.comment_id
        AND posts.creator_id = public.current_creator_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM comments
      JOIN posts ON posts.id = comments.post_id
      WHERE comments.id = comment_categories.comment_id
        AND posts.creator_id = public.current_creator_id()
    )
  );

-- ---------------------------------------------------------------------------
-- audience_members — creator_id is direct.
-- ---------------------------------------------------------------------------
ALTER TABLE audience_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audience_members_own_creator ON audience_members;
CREATE POLICY audience_members_own_creator ON audience_members
  FOR ALL TO authenticated
  USING (creator_id = public.current_creator_id())
  WITH CHECK (creator_id = public.current_creator_id());

-- ---------------------------------------------------------------------------
-- reward_events — reached through audience_members.
--
-- Deliberately NOT through post_id: 110 existing rows have a null post_id, and a
-- post_id-based policy would make every one of them invisible to its owner.
-- audience_member_id is the column that is always populated.
--
-- The public claim flow is intentionally not expressed here. A claim link is a
-- bearer token held by an anonymous visitor, and the only policy that could
-- serve it is USING (true), which would publish every reward row in the
-- database. That path uses the service-role key instead.
-- ---------------------------------------------------------------------------
ALTER TABLE reward_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reward_events_own_creator ON reward_events;
CREATE POLICY reward_events_own_creator ON reward_events
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM audience_members
      WHERE audience_members.id = reward_events.audience_member_id
        AND audience_members.creator_id = public.current_creator_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM audience_members
      WHERE audience_members.id = reward_events.audience_member_id
        AND audience_members.creator_id = public.current_creator_id()
    )
  );

-- ---------------------------------------------------------------------------
-- notifications — creator_id is direct.
-- ---------------------------------------------------------------------------
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_own_creator ON notifications;
CREATE POLICY notifications_own_creator ON notifications
  FOR ALL TO authenticated
  USING (creator_id = public.current_creator_id())
  WITH CHECK (creator_id = public.current_creator_id());

-- ---------------------------------------------------------------------------
-- tracked_videos — creator_id is direct.
-- ---------------------------------------------------------------------------
ALTER TABLE tracked_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tracked_videos_own_creator ON tracked_videos;
CREATE POLICY tracked_videos_own_creator ON tracked_videos
  FOR ALL TO authenticated
  USING (creator_id = public.current_creator_id())
  WITH CHECK (creator_id = public.current_creator_id());

-- ---------------------------------------------------------------------------
-- channel_videos — creator_id is direct.
-- ---------------------------------------------------------------------------
ALTER TABLE channel_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_videos_own_creator ON channel_videos;
CREATE POLICY channel_videos_own_creator ON channel_videos
  FOR ALL TO authenticated
  USING (creator_id = public.current_creator_id())
  WITH CHECK (creator_id = public.current_creator_id());

-- ---------------------------------------------------------------------------
-- channel_stats_snapshots — creator_id is direct. Currently written only by the
-- service-role path, but scoped anyway so a future anon-key read is safe.
-- ---------------------------------------------------------------------------
ALTER TABLE channel_stats_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_stats_snapshots_own_creator ON channel_stats_snapshots;
CREATE POLICY channel_stats_snapshots_own_creator ON channel_stats_snapshots
  FOR ALL TO authenticated
  USING (creator_id = public.current_creator_id())
  WITH CHECK (creator_id = public.current_creator_id());

-- ---------------------------------------------------------------------------
-- platforms — a shared lookup table ('youtube'), owned by nobody. It holds no
-- creator data, so it is readable by any signed-in user and writable by none.
-- ---------------------------------------------------------------------------
ALTER TABLE platforms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platforms_read_all ON platforms;
CREATE POLICY platforms_read_all ON platforms
  FOR SELECT TO authenticated
  USING (true);
