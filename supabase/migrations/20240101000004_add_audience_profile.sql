-- Migration: add audience memory (profile_summary) to audience_members
-- Run this in your Supabase SQL editor

ALTER TABLE audience_members ADD COLUMN IF NOT EXISTS profile_summary text;
ALTER TABLE audience_members ADD COLUMN IF NOT EXISTS profile_updated_at timestamptz;
