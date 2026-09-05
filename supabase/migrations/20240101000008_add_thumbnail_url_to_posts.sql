-- Migration: add thumbnail_url to posts, for the upcoming visual redesign
-- Run this in your Supabase SQL editor

ALTER TABLE posts ADD COLUMN IF NOT EXISTS thumbnail_url text;
