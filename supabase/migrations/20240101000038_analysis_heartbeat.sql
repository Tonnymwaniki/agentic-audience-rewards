-- Migration 38: stale-run detection for post analysis.
--
-- An analysis runs in a background job (after()). If that job is killed — a
-- function timeout, a deploy, a crashed dev worker — nothing ever writes its final
-- status, and the post stays analysis_status='running' forever. To tell a live run
-- from a dead one we need to know when it last made progress.
--
-- analysis_heartbeat_at is stamped BY THE DATABASE whenever a write names any of
-- the progress columns. A trigger rather than application code, so every writer
-- (the analyze route, the reward-evaluate route, anything added later) keeps it
-- current without having to remember to.
--
-- "BEFORE UPDATE OF <columns>" fires when a column is named in the UPDATE's SET
-- list, even if its value is unchanged. That is deliberate: re-sending the same
-- progress count still proves the job is alive, and a restarted run that writes
-- the same starting values as the dead one must refresh the heartbeat.
-- Ingest's upsert of view/like counts does not name these columns, so refreshing
-- a video's statistics is not mistaken for analysis progress.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS analysis_heartbeat_at timestamptz;

CREATE OR REPLACE FUNCTION posts_touch_analysis_heartbeat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.analysis_heartbeat_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS posts_analysis_heartbeat ON posts;
CREATE TRIGGER posts_analysis_heartbeat
  BEFORE UPDATE OF analysis_status, analysis_stage, comments_categorized, members_evaluated, members_total
  ON posts
  FOR EACH ROW
  EXECUTE FUNCTION posts_touch_analysis_heartbeat();

-- Any run already in flight when this is applied gets a fresh heartbeat, so it is
-- given the full grace period rather than being judged on a missing timestamp.
-- (Naming only analysis_heartbeat_at does not fire the trigger above.)
UPDATE posts SET analysis_heartbeat_at = now() WHERE analysis_status = 'running';

-- The stale-run sweep looks only at running posts.
CREATE INDEX IF NOT EXISTS posts_running_heartbeat_idx
  ON posts (analysis_heartbeat_at)
  WHERE analysis_status = 'running';
