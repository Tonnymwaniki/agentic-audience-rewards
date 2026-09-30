-- Two related additions:
--
-- 1. Pinned comments. The YouTube Data API exposes NO field for "is this comment
--    pinned" (checked against the commentThreads resource docs — snippet only has
--    channelId/videoId/topLevelComment/canReply/totalReplyCount/isPublic). Since
--    this app fetches comments via commentThreads.list with the default
--    order=relevance (no `order` param is set), the pinned comment is very
--    commonly the first item returned — YouTube's relevance ranking favors it —
--    but this is undocumented, unofficial behavior, not a guarantee. So
--    pinned_comment_id is written as a best-effort GUESS at ingest time
--    (lib/ingest.ts), and pinned_comment_confirmed distinguishes "our guess" from
--    "the creator confirmed/corrected this" so the Pinned Comments page never
--    mixes the two silently.
--
-- 2. Owner-reply detection. Every reply is already ingested with authorChannelId,
--    and every post already has channel_id — nobody was comparing the two. A
--    top-level comment the channel owner already personally replied to went
--    through normal LLM categorization and could land in any bucket (including
--    "other"), indistinguishable from something nobody has addressed. This adds
--    owner_replied_at/owner_reply_comment_id, computed for free from data already
--    ingested (backfilled below with no new API calls), and a matching
--    draft_skip_reason so it's excluded from drafting instead of quietly
--    reclassified.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS pinned_comment_id uuid REFERENCES comments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pinned_comment_confirmed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN posts.pinned_comment_id IS
  'Best-effort guess (or creator-confirmed) id of this video''s pinned top-level comment. YouTube''s API has no pinned field; see migration header.';
COMMENT ON COLUMN posts.pinned_comment_confirmed IS
  'false = pinned_comment_id is only our relevance-order guess. true = the creator confirmed it (or picked a different comment) on the Pinned Comments page.';

ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS owner_replied_at timestamptz,
  ADD COLUMN IF NOT EXISTS owner_reply_comment_id uuid REFERENCES comments(id) ON DELETE SET NULL;

COMMENT ON COLUMN comments.owner_replied_at IS
  'Set on a top-level comment when the channel owner (author_channel_id of some reply = this post''s channel_id) has already replied. Computed at ingest time; NULL means no owner reply (yet).';
COMMENT ON COLUMN comments.owner_reply_comment_id IS
  'The stored id of the owner''s reply comment, for displaying it directly under the parent. Null unless owner_replied_at is set.';

CREATE INDEX IF NOT EXISTS idx_posts_pinned_comment_id ON posts (pinned_comment_id) WHERE pinned_comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_owner_replied_at ON comments (post_id) WHERE owner_replied_at IS NOT NULL;

-- Extend draft_skip_reason (migration 53) with the new skip path. Inline column
-- CHECK constraints are auto-named <table>_<column>_check.
ALTER TABLE comment_categories DROP CONSTRAINT IF EXISTS comment_categories_draft_skip_reason_check;
ALTER TABLE comment_categories ADD CONSTRAINT comment_categories_draft_skip_reason_check
  CHECK (draft_skip_reason IN (
    'unscreened',
    'not_business_relevant',
    'relevance_check_failed',
    'draft_generation_failed',
    'unverified_channel',
    -- The channel owner already personally replied to this comment — correctly
    -- excluded from drafting, not a gap, so (like not_business_relevant) this
    -- never triggers a notification on its own.
    'owner_already_replied'
  ));

-- Backfill owner_replied_at/owner_reply_comment_id from data already ingested —
-- no new YouTube API calls needed. For each top-level comment, finds its
-- earliest reply whose author's external_id matches the post's own channel_id.
WITH owner_replies AS (
  SELECT DISTINCT ON (reply.parent_comment_id)
    reply.parent_comment_id AS parent_id,
    reply.id AS reply_id,
    reply.posted_at AS replied_at
  FROM comments reply
  JOIN audience_members am ON am.id = reply.audience_member_id
  JOIN comments parent ON parent.id = reply.parent_comment_id
  JOIN posts p ON p.id = parent.post_id
  WHERE reply.parent_comment_id IS NOT NULL
    AND p.channel_id IS NOT NULL
    AND am.external_id = p.channel_id
  ORDER BY reply.parent_comment_id, reply.posted_at ASC
)
UPDATE comments AS parent
SET owner_replied_at = owner_replies.replied_at,
    owner_reply_comment_id = owner_replies.reply_id
FROM owner_replies
WHERE parent.id = owner_replies.parent_id
  AND parent.owner_replied_at IS NULL;

-- Matching skip reason for every comment the backfill just found to already be
-- answered, so it stops looking like an open item in Notifications immediately
-- (not just on the next re-ingest).
UPDATE comment_categories cc
SET draft_skip_reason = 'owner_already_replied'
FROM comments c
WHERE cc.comment_id = c.id
  AND c.owner_replied_at IS NOT NULL
  AND cc.draft_reply_approved_at IS NULL
  AND cc.category IN ('purchase_intent', 'question', 'complaint');
