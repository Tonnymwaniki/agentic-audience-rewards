-- Migration: add notifications table for business-relevant comment alerts
-- Run this in your Supabase SQL editor

CREATE TABLE IF NOT EXISTS notifications (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references creators(id) not null,
  comment_id uuid references comments(id) not null,
  type text not null, -- 'purchase_intent' | 'question' | 'complaint'
  message text not null,
  read boolean default false,
  created_at timestamptz default now()
);

-- Speeds up the bell's "unread count" and "recent notifications" queries
CREATE INDEX IF NOT EXISTS notifications_creator_created_idx
  ON notifications (creator_id, created_at desc);
CREATE INDEX IF NOT EXISTS notifications_creator_unread_idx
  ON notifications (creator_id, read);
