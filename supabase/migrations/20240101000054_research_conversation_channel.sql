-- Research chat currently blends a creator's own channel together with every
-- other channel they've ever researched (paste-any-channel-URL competitor
-- research) into one pool of posts/comments — so "what does my audience think"
-- can silently include someone else's audience. This column lets a conversation
-- be scoped to one channel at the time it's started, and buildResearchContext
-- (lib/research/engine.ts) filters its post set to it for every turn of that
-- conversation from then on.
--
-- Nullable, and stays null for every conversation started before this shipped —
-- those keep today's behavior (all channels blended) rather than being
-- retroactively (and incorrectly) assigned a channel nobody chose for them.
ALTER TABLE research_conversations
  ADD COLUMN IF NOT EXISTS channel_id text;

COMMENT ON COLUMN research_conversations.channel_id IS
  'YouTube channel id this conversation is scoped to, or NULL for "all channels" (the only behavior before this column existed). Set once at conversation creation and never changed — scope stays consistent across every turn of one conversation.';
