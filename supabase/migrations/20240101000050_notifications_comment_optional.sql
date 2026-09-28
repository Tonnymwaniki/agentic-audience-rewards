-- notifications.comment_id was NOT NULL because every notification used to be
-- about one comment (purchase_intent/question/complaint). Account-level events
-- (billing upgrade confirmed, stuck-payment alert) have no comment to attach to,
-- so this relaxes the constraint. Existing rows are untouched — every one of
-- them already has a comment_id, this only permits new rows to omit it.
ALTER TABLE notifications ALTER COLUMN comment_id DROP NOT NULL;
