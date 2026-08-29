-- Migration: add channel_url to creators table
-- Run this in your Supabase SQL editor

ALTER TABLE creators ADD COLUMN IF NOT EXISTS channel_url text;
