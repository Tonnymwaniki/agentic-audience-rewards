-- Migration: add business_category to creators, for future aggregate benchmarking
-- Run this in your Supabase SQL editor
--
-- Data collection only for now — nothing reads this field yet.

ALTER TABLE creators ADD COLUMN IF NOT EXISTS business_category text;
