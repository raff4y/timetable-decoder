-- Each user's picked sections per timetable. Requires app_users (001) and timetables (002).

CREATE TABLE saved_schedules (
  user_id            uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  timetable_id       uuid NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
  section_keys       text[] NOT NULL DEFAULT '{}',          -- 'CODE|SECTION'
  color_assignments  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, timetable_id)
);

CREATE INDEX saved_schedules_timetable_idx ON saved_schedules (timetable_id);
