-- Migration: audience levels
-- Run this in your Supabase SQL editor. Requires 20240101000028.
--
-- A person's LEVEL combines how often this creator has recognized them
-- (reward_events) with how much they actually engage (comment count, distinct
-- videos). Computed from stored data by fixed, explainable rules (lib/levels.ts)
-- — no per-person AI guessing — and refreshed whenever their audience-memory
-- profile is refreshed, exactly like `segment`.
--
-- Level is deliberately a separate column from segment rather than a replacement:
-- segment says what KIND of person someone is (potential customer, critic),
-- level says how INVESTED they are. Both are useful about the same person.
--
-- Safe to run before or after the matching code deploys: lib/levels.ts writes the
-- level only once the column exists, and degrades silently when it does not
-- (PGRST204 / 42703), so nothing breaks in the window between the two.

BEGIN;

-- One of: new | regular | rising_fan | super_fan.
-- NULL means "not computed yet"; readers treat that as unranked rather than 'new',
-- so a member who predates this migration is never mislabelled as a newcomer.
ALTER TABLE audience_members ADD COLUMN IF NOT EXISTS level text;

-- The read pattern this adds: "this creator's people at level X", which is how
-- Agent Home's recognized-people cards and any future filter will query it.
CREATE INDEX IF NOT EXISTS audience_members_creator_level_idx ON audience_members (creator_id, level);

-- Counting a person's recognitions is the one new per-member read levels add
-- (lib/levels.ts: reward_events filtered by audience_member_id). Without this the
-- count is a sequential scan of the whole table per member during a backfill.
CREATE INDEX IF NOT EXISTS reward_events_member_idx ON reward_events (audience_member_id);

NOTIFY pgrst, 'reload schema';

COMMIT;
