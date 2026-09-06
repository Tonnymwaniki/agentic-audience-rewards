-- Migration: add verified business facts to creators, for grounding drafted replies
-- Run this in your Supabase SQL editor

ALTER TABLE creators ADD COLUMN IF NOT EXISTS business_phone text;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS business_whatsapp text;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS business_location text;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS business_hours text;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS business_website text;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS delivery_info text;
