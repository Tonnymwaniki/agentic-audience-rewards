-- Tracks whether an approved draft actually made it to YouTube as a real reply
-- comment (app/api/draft-reply/approve, lib/youtube-reply.ts), separately from
-- draft_reply_approved_at/final_reply_text which only record the creator's
-- decision, not whether posting it succeeded.
--
-- reply_send_status starts NULL for every existing approved reply (this feature
-- did not exist before, so nothing was ever actually sent) and is only set going
-- forward. 'skipped' covers the ordinary Free-plan and not-yet-reply-enabled
-- cases — not a failure, just "approval saved, nothing sent."
ALTER TABLE comment_categories
  ADD COLUMN IF NOT EXISTS reply_send_status text
    CHECK (reply_send_status IN ('sent', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS reply_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_reply_comment_id text,
  ADD COLUMN IF NOT EXISTS reply_send_error text;
