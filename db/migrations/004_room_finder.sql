-- 004: Free Room Finder accounts and sessions.
--
-- The Room Finder has its own login, separate from the timetable tool's Neon
-- Auth accounts: nobody can sign up, an admin creates every account, and an
-- app_users login does not open it (nor the other way round). Passwords are
-- scrypt hashes (server/rooms/auth.js); sessions are opaque random tokens kept
-- here as SHA-256 hashes, so disabling an account or resetting its password
-- signs it out everywhere at once.

CREATE TABLE room_finder_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             citext NOT NULL UNIQUE,
  display_name         text NOT NULL DEFAULT '',
  password_hash        text NOT NULL,
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'disabled')),
  created_by           uuid REFERENCES app_users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz
);

CREATE TABLE room_finder_sessions (
  token_hash  text PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES room_finder_accounts (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX room_finder_sessions_account_idx ON room_finder_sessions (account_id);
CREATE INDEX room_finder_sessions_expiry_idx ON room_finder_sessions (expires_at);
