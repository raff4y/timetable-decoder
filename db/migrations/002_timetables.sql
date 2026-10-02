-- Timetables uploaded by admins, plus their parsed sections and meetings.
-- Requires app_users (001).

CREATE TABLE timetables (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department          text NOT NULL DEFAULT '',
  semester            text NOT NULL DEFAULT '',
  title               text NOT NULL DEFAULT '',
  template            text NOT NULL CHECK (template IN ('flat', 'grid')),
  -- True when every meeting states its own length (grid template); false when
  -- some are null and the client applies its theory/lab defaults.
  explicit_durations  boolean NOT NULL DEFAULT false,
  section_count       integer NOT NULL DEFAULT 0,
  is_published        boolean NOT NULL DEFAULT false,

  -- The original upload, kept so a timetable can be re-parsed later.
  file_name           text NOT NULL DEFAULT '',
  file_bytes          bytea NOT NULL,
  file_size           integer NOT NULL,
  file_sha256         text NOT NULL,

  -- Non-fatal parser notes (string[]).
  warnings            jsonb NOT NULL DEFAULT '[]'::jsonb,

  uploaded_by         uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- An exact duplicate upload is rejected (the API turns this into a 409).
CREATE UNIQUE INDEX timetables_file_sha256_key ON timetables (file_sha256);
CREATE INDEX timetables_published_idx ON timetables (is_published, created_at DESC);

-- One row per (course code, section); `position` keeps the parser's ordering.
-- The client-side key is code || '|' || section.
CREATE TABLE sections (
  id            bigserial PRIMARY KEY,
  timetable_id  uuid NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  code          text NOT NULL,
  name          text NOT NULL DEFAULT '',
  section       text NOT NULL,
  teacher       text NOT NULL DEFAULT '',
  batch         text NOT NULL DEFAULT '',
  name_is_lab   boolean NOT NULL DEFAULT false,
  UNIQUE (timetable_id, code, section)
);

CREATE INDEX sections_timetable_position_idx ON sections (timetable_id, position);

CREATE TABLE meetings (
  id          bigserial PRIMARY KEY,
  section_id  bigint NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  day_idx     smallint NOT NULL CHECK (day_idx BETWEEN 0 AND 6), -- 0 = Monday
  start_min   integer NOT NULL CHECK (start_min >= 0),
  raw_time    text NOT NULL DEFAULT '',
  room        text NOT NULL DEFAULT '',
  dur_min     integer CHECK (dur_min IS NULL OR dur_min > 0), -- null = not stated by the file
  is_lab      boolean NOT NULL DEFAULT false -- nameIsLab OR room mentions "lab"
);

CREATE INDEX meetings_section_idx ON meetings (section_id, position);
