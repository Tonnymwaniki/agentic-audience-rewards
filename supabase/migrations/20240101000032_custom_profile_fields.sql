-- Migration: AI-generated custom Business Profile fields
-- Run this in your Supabase SQL editor. Requires 20240101000018 (RLS helpers).
--
-- The fixed profile columns on `creators` (phone, WhatsApp, location, hours,
-- website, delivery) suit every business. This table holds the handful of extra
-- fields that only make sense for THIS creator's business — "Class schedule" for
-- a tutor, "Wholesale minimum order" for a retailer — generated once from their
-- real category, video titles and comment topics.
--
-- Shape follows the brief exactly: one row per field, keyed per creator.
--
-- Deliberately a table rather than a jsonb column on `creators`: each field has
-- its own generated_at and its own uniqueness guarantee, and a partial write to
-- one field can't clobber another the way a whole-document jsonb update can.

BEGIN;

CREATE TABLE IF NOT EXISTS custom_profile_fields (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references creators(id) not null,
  -- Stable machine key, e.g. 'class_schedule'. Never shown to the creator.
  field_key text not null,
  -- What the creator actually reads, e.g. 'Class schedule'.
  field_label text not null,
  -- NULL until the creator fills it in. Generation stores definitions only.
  field_value text,
  generated_at timestamptz default now(),
  unique(creator_id, field_key)
);

-- The read pattern: "this creator's custom fields", on the profile page and in
-- every draft-reply generation.
CREATE INDEX IF NOT EXISTS custom_profile_fields_creator_idx
  ON custom_profile_fields (creator_id);

-- RLS matching the rest of the schema: the owner may read their own rows; every
-- write goes through the service role, which bypasses RLS. Same shape as
-- channel_videos_select_own (migration 31), and written as a direct subquery on
-- creators so it does not depend on public.current_creator_id() existing.
ALTER TABLE custom_profile_fields ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custom_profile_fields_select_own ON custom_profile_fields;

CREATE POLICY custom_profile_fields_select_own ON custom_profile_fields
  FOR SELECT TO authenticated
  USING (
    creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
