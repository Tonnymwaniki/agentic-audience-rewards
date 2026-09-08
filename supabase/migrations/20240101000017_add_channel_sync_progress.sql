-- Migration: progress tracking for the background channel-video sync
-- Run this in your Supabase SQL editor
--
-- Mirrors how posts.analysis_status / analysis_stage let the analyze flow report
-- progress: the request returns immediately and the client polls these columns.
-- Without them a large channel looks frozen for ten seconds or more.

-- 'idle' | 'syncing' | 'done' | 'error'
ALTER TABLE creators ADD COLUMN IF NOT EXISTS channel_sync_status text DEFAULT 'idle';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS channel_videos_synced_count int DEFAULT 0;
-- Populated only when the safety cap stops a sync early, so a genuinely huge
-- channel is visible rather than silently truncated.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS channel_sync_hit_cap boolean DEFAULT false;
