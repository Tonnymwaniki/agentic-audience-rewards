-- Migration: restore the missing SELECT policy on channel_videos.
--
-- WHY THIS IS NEEDED
--
-- channel_videos currently has RLS ENABLED with no policy that grants the owning
-- creator anything. Verified against the live database:
--
--   anon, no session   -> 0 rows          (so RLS is on; with RLS off this would
--                                          have returned every row)
--   owner, signed in   -> 0 rows, owns 1  (so no SELECT policy matches them)
--   owner INSERT       -> "new row violates row-level security policy"
--
-- Enabled-with-no-policy denies everything, silently, for reads. That is why
-- My Videos renders "No videos yet. Connect a channel to get started." even
-- immediately after a channel sync has written rows successfully: the dashboard
-- pages read with the end user's own token (lib/supabase/server.ts uses the anon
-- key plus the session), so RLS applies to them and returns an empty set.
--
-- The policy below matches the shape already used by the working creator-scoped
-- tables. It is written as a direct subquery on creators rather than calling
-- public.current_creator_id(), so that applying this file does not depend on that
-- helper existing — migration 18, which defines it, is only partially applied on
-- this database. The subquery is safe: creators' own policy (creators_own_row)
-- lets a signed-in user see exactly their own row, so this resolves to their
-- creator id and nothing else.
--
-- SELECT only, deliberately. Every write to channel_videos goes through the
-- service-role key (lib/channel-videos.ts, called from the connect route), which
-- bypasses RLS entirely. Granting the end-user token INSERT/UPDATE/DELETE would
-- widen the surface for no gain. If you would rather mirror migration 18's
-- FOR ALL house style, swap the two marked lines — nothing else changes.
--
-- Safe to re-run: the DROP IF EXISTS makes it idempotent, and enabling RLS on a
-- table that already has it is a no-op.

ALTER TABLE channel_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_videos_select_own ON channel_videos;
DROP POLICY IF EXISTS channel_videos_own_creator ON channel_videos;

CREATE POLICY channel_videos_select_own ON channel_videos
  FOR SELECT TO authenticated                 -- swap to: FOR ALL TO authenticated
  USING (
    creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
  );                                          -- and add: WITH CHECK (same expression)

-- The policy filters on creator_id on every row read, so it needs this index to
-- avoid turning each read into a sequential scan. Migration 18 creates the same
-- index; IF NOT EXISTS makes running both harmless.
CREATE INDEX IF NOT EXISTS channel_videos_creator_idx ON channel_videos (creator_id);
