-- 005: data behind the admin CMS (cms.html): an audit log of admin actions,
-- and per-user activity so the dashboard can report who is actually using the
-- app. Requires app_users (001).

-- When each user last made an authenticated API call. Written at most every
-- few minutes per user (server/activity.js), so it is "last seen", not exact.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- One row per user per day (Asia/Karachi) on which they used the app. Powers
-- the daily / weekly / monthly active-user figures without an event stream.
CREATE TABLE IF NOT EXISTS user_activity_days (
  user_id  uuid NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  day      date NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS user_activity_days_day_idx ON user_activity_days (day);

-- Every admin write (user approvals, role changes, timetable uploads, ...).
-- actor_email is copied so entries stay readable after the actor is deleted.
CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     uuid REFERENCES app_users (id) ON DELETE SET NULL,
  actor_email  text NOT NULL DEFAULT '',
  action       text NOT NULL,           -- e.g. 'user.approve', 'timetable.upload'
  target_type  text NOT NULL DEFAULT '', -- 'user' | 'timetable'
  target_id    text NOT NULL DEFAULT '',
  summary      text NOT NULL DEFAULT '', -- human-readable one-liner
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, created_at DESC);

-- Trend charts bucket sign-ups and saves by day.
CREATE INDEX IF NOT EXISTS app_users_created_idx ON app_users (created_at);
CREATE INDEX IF NOT EXISTS saved_schedules_updated_idx ON saved_schedules (updated_at);
