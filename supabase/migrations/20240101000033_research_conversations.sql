-- Migration: persisted Research chat conversations
-- Run this in your Supabase SQL editor. Requires 20240101000018.
--
-- Until now a Research conversation lived only in React state: it survived moving
-- between /research and /research/chat, and died on a page reload. These tables
-- make it durable, listable and resumable.
--
-- Only role + content are stored per message. The cards and citation chips an
-- answer rendered are NOT persisted: they are derived from evidence ids that may
-- since have changed, and showing a stale "3 comments across 1 video" chip next to
-- a resumed answer would be a quiet lie. A resumed conversation shows its prose,
-- and any NEW answer in it gets fresh cards.

BEGIN;

CREATE TABLE IF NOT EXISTS research_conversations (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references creators(id) not null,
  -- NULL until the auto-title lands; the UI falls back to the first question.
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

CREATE TABLE IF NOT EXISTS research_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references research_conversations(id) not null,
  role text not null,
  content text not null,
  created_at timestamptz default now()
);

-- The list view orders by recency within one creator.
CREATE INDEX IF NOT EXISTS research_conversations_creator_updated_idx
  ON research_conversations (creator_id, updated_at DESC);

-- Loading one conversation reads its messages in order.
CREATE INDEX IF NOT EXISTS research_messages_conversation_idx
  ON research_messages (conversation_id, created_at);

-- RLS matching the rest of the schema: the owner may read their own rows, writes
-- go through the service role. Conversations scope directly on creator_id;
-- messages scope one hop further, through their conversation — the same shape the
-- comments policy uses to reach posts.creator_id.
ALTER TABLE research_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS research_conversations_select_own ON research_conversations;
CREATE POLICY research_conversations_select_own ON research_conversations
  FOR SELECT TO authenticated
  USING (
    creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS research_messages_select_own ON research_messages;
CREATE POLICY research_messages_select_own ON research_messages
  FOR SELECT TO authenticated
  USING (
    conversation_id IN (
      SELECT rc.id FROM research_conversations rc
      WHERE rc.creator_id IN (SELECT id FROM creators WHERE user_id = auth.uid())
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
