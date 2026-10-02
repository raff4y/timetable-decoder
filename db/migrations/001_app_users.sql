-- 001: application users (role + approval status), linked to Neon Auth.
-- The credentials themselves live in Neon's `neon_auth` schema; this table is
-- ours. See docs/ARCHITECTURE.md ("Database") and server/auth.js.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE app_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- neon_auth.user.id of the linked account; NULL for pre-added people until
  -- their first verified sign-in.
  auth_user_id  text UNIQUE,
  email         citext NOT NULL UNIQUE,
  display_name  text NOT NULL DEFAULT '',
  role          text NOT NULL DEFAULT 'student'
                CHECK (role IN ('student', 'admin')),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
  source        text NOT NULL DEFAULT 'signup'
                CHECK (source IN ('signup', 'preadded')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_at   timestamptz,
  approved_by   uuid REFERENCES app_users (id) ON DELETE SET NULL
);

CREATE INDEX app_users_status_idx ON app_users (status, created_at);

-- Fixed-window counters for abuse throttling (password-reset requests).
-- Keys are hashed by the caller; rows are disposable.
CREATE TABLE auth_rate_limits (
  key           text PRIMARY KEY,
  count         integer NOT NULL DEFAULT 0,
  window_start  timestamptz NOT NULL DEFAULT now()
);
