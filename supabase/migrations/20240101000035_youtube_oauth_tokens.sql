-- Google OAuth tokens for verified YouTube channel ownership.
--
-- Kept in a SEPARATE TABLE rather than as columns on `creators`, deliberately:
--
--  * `creators` is read on nearly every page load (Agent Home, Me, Connect, the
--    layout). Those reads mostly use `select('id, display_name, ...')`, but any
--    `select('*')` would pull an encrypted refresh token into a React Server
--    Component's props for no reason. A separate table means the secret is only
--    ever read by the code that deliberately asks for it.
--  * It makes "revoke and forget" a single DELETE rather than four column
--    updates that could half-fail.
--
-- The refresh token is stored ENCRYPTED (AES-256-GCM, see lib/youtube-oauth.ts).
-- It grants ongoing read access to the person's YouTube account, so unlike the
-- other data here it is not safe at rest behind RLS alone: anyone who obtains a
-- database dump obtains standing access to every connected account. The access
-- token is encrypted the same way for consistency, though it expires in an hour.
--
-- `channel_id` is the ownership PROOF: it comes from channels.list?mine=true,
-- answered by Google against the user's own credentials, not from anything typed
-- into the app.

CREATE TABLE IF NOT EXISTS youtube_oauth_tokens (
  creator_id uuid PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,

  -- AES-256-GCM ciphertext, format "v1.<iv>.<tag>.<ciphertext>" (base64url).
  access_token_encrypted text NOT NULL,
  refresh_token_encrypted text,

  -- Absolute instant, so freshness does not depend on when the row was read.
  expires_at timestamptz NOT NULL,

  -- Space-separated scopes Google actually granted, which can be narrower than
  -- what was requested if the user unticked a box.
  scope text NOT NULL DEFAULT '',

  -- The verified channel. NULL means the account authorized but owns no channel.
  channel_id text,
  channel_title text,
  channel_custom_url text,

  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One creator per row is enforced by the primary key; this supports the reverse
-- lookup ("is this channel already claimed by someone?"), which is what stops two
-- accounts both verifying the same channel.
CREATE INDEX IF NOT EXISTS idx_youtube_oauth_tokens_channel
  ON youtube_oauth_tokens (channel_id)
  WHERE channel_id IS NOT NULL;

ALTER TABLE youtube_oauth_tokens ENABLE ROW LEVEL SECURITY;

-- DELIBERATELY NO POLICY FOR anon OR authenticated.
--
-- Every other creator-owned table grants the owner a SELECT policy so pages can
-- read their own rows with the cookie-scoped client. This table must not: the
-- browser never has any reason to read an encrypted refresh token, and a SELECT
-- policy would make it reachable from client-side code via PostgREST. Only the
-- service-role client (which bypasses RLS) touches this table, and only inside
-- the OAuth routes. RLS is enabled with no policies so the default deny applies
-- to everyone else.

-- `creators.channel_url` stays as-is for now: the pasted-URL path still works and
-- the OAuth path writes it too, so existing sync code keeps functioning unchanged
-- whichever way the channel was connected. What changes is that a row in THIS
-- table is proof the creator actually owns it.
COMMENT ON TABLE youtube_oauth_tokens IS
  'Google OAuth tokens proving YouTube channel ownership. Refresh token is AES-256-GCM encrypted; service-role access only.';
