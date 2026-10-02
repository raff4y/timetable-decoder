-- 006: session revocation and general API rate limiting. Requires 001.
-- See server/auth.js (revocation) and server/rate-limit.js (limits).

-- Any Neon Auth JWT issued at or before this instant is refused, even if it has
-- not expired yet. Set when an admin revokes a user's access or forces a sign-out,
-- so that person is signed out on their very next request.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS sessions_revoked_at timestamptz;

-- auth_rate_limits now backs every limit, not only password resets, and each key
-- carries its own window length so one upsert can count several keys at once.
ALTER TABLE auth_rate_limits ADD COLUMN IF NOT EXISTS window_seconds integer NOT NULL DEFAULT 900
  CHECK (window_seconds > 0);

-- Lets the periodic cleanup of expired counters use an index.
CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx ON auth_rate_limits (window_start);
