-- Migration: add analysis progress tracking to posts table
-- Run this in your Supabase SQL editor

ALTER TABLE posts ADD COLUMN IF NOT EXISTS analysis_status text DEFAULT 'idle';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS analysis_stage text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS comments_total int DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS comments_categorized int DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS members_evaluated int DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS members_total int DEFAULT 0;
