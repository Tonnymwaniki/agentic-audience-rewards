-- Migration: comment replies
-- Run this in your Supabase SQL editor. Requires 20240101000023 (comments.like_count).
--
-- Replies are stored as ordinary rows in `comments`, pointing at the top-level
-- comment they answer. Nothing downstream special-cases them: categorization,
-- embeddings, search, trending and rewards all read `comments` rows and therefore
-- pick replies up automatically.
--
-- Safe to run before or after the matching code deploys: ingestion only fetches
-- replies once these columns exist (it probes first and skips them until then),
-- so a reply can never be stored without its parent link.

BEGIN;

-- The top-level comment this is a reply to; NULL for top-level comments. ON DELETE
-- CASCADE so removing a comment removes the thread under it, matching how deleting
-- a post removes its comments.
ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_comment_id uuid REFERENCES comments(id) ON DELETE CASCADE;

-- YouTube's totalReplyCount for a top-level comment: how many replies the thread has
-- on YouTube, which can exceed the number stored here because reply fetching is
-- capped per video. 0 for replies themselves.
ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_count int DEFAULT 0;

-- The read pattern this adds: "the replies under this comment".
CREATE INDEX IF NOT EXISTS comments_parent_comment_id_idx ON comments (parent_comment_id) WHERE parent_comment_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
