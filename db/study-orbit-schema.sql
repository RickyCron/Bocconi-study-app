-- Study Orbit planner tables
-- Run this in Supabase Dashboard -> SQL Editor if Orbit says its tables are missing.
--
-- NOTE: This file duplicates the "Study Orbit planner" section of db/schema.sql
-- (lines 184–259 in the canonical schema). It exists as a quick fallback so
-- you can apply just the Orbit tables without re-running the full schema.
-- If you change one, mirror the change in the other.

CREATE TABLE IF NOT EXISTS study_preferences (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wake_time            TEXT NOT NULL DEFAULT '08:30',
  bed_time             TEXT NOT NULL DEFAULT '23:30',
  daily_effort         TEXT NOT NULL DEFAULT 'medium' CHECK (daily_effort IN ('low', 'medium', 'high')),
  preferred_techniques TEXT[] DEFAULT ARRAY['notes','update','deeper','quiz'],
  unavailable_blocks   JSONB DEFAULT '[]',
  daily_overrides      JSONB DEFAULT '{}',
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE study_preferences ADD COLUMN IF NOT EXISTS daily_effort TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE study_preferences ADD COLUMN IF NOT EXISTS preferred_techniques TEXT[] DEFAULT ARRAY['notes','update','deeper','quiz'];
ALTER TABLE study_preferences ADD COLUMN IF NOT EXISTS unavailable_blocks JSONB DEFAULT '[]';
ALTER TABLE study_preferences ADD COLUMN IF NOT EXISTS daily_overrides JSONB DEFAULT '{}';
ALTER TABLE study_preferences ADD COLUMN IF NOT EXISTS setup_complete BOOLEAN DEFAULT FALSE;
ALTER TABLE study_preferences ADD COLUMN IF NOT EXISTS exam_overrides JSONB DEFAULT '{}';

CREATE TABLE IF NOT EXISTS study_course_ratings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES users(id) ON DELETE CASCADE,
  course_id           TEXT NOT NULL,
  session_id          TEXT NOT NULL DEFAULT '__course__',
  slide_load          TEXT NOT NULL DEFAULT 'medium' CHECK (slide_load IN ('low', 'medium', 'high')),
  lecture_depth       TEXT NOT NULL DEFAULT 'medium' CHECK (lecture_depth IN ('low', 'medium', 'high')),
  required_depth      TEXT NOT NULL DEFAULT 'medium' CHECK (required_depth IN ('low', 'medium', 'high')),
  syllabus_difficulty TEXT NOT NULL DEFAULT 'medium' CHECK (syllabus_difficulty IN ('low', 'medium', 'high')),
  effort              TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('low', 'medium', 'high')),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, course_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_study_ratings_user_course ON study_course_ratings(user_id, course_id);

CREATE TABLE IF NOT EXISTS study_resource_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id  TEXT NOT NULL,
  session_id TEXT,
  type       TEXT DEFAULT 'video',
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  topic      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_resources_course ON study_resource_links(course_id, session_id);

CREATE TABLE IF NOT EXISTS study_plan_days (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  plan_date     DATE NOT NULL,
  wake_time     TEXT NOT NULL DEFAULT '08:30',
  bed_time      TEXT NOT NULL DEFAULT '23:30',
  effort_level  TEXT NOT NULL DEFAULT 'medium',
  summary       JSONB DEFAULT '{}',
  generated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, plan_date)
);

CREATE INDEX IF NOT EXISTS idx_study_days_user_date ON study_plan_days(user_id, plan_date);

CREATE TABLE IF NOT EXISTS study_plan_tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id           UUID REFERENCES study_plan_days(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  course_id        TEXT NOT NULL,
  session_id       TEXT,
  start_time       TEXT NOT NULL,
  end_time         TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  task_type        TEXT NOT NULL,
  tool             TEXT NOT NULL,
  title            TEXT NOT NULL,
  reasoning        TEXT NOT NULL,
  resource_url     TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'skipped')),
  generated_key    TEXT NOT NULL,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_tasks_day ON study_plan_tasks(day_id, status);
CREATE INDEX IF NOT EXISTS idx_study_tasks_user_key ON study_plan_tasks(user_id, generated_key, status);

-- Agent memory: persistent observations about the user's study patterns and preferences.
-- The agent writes to `facts` (key→prose map) and `summary` (prose paragraph for the system prompt).
CREATE TABLE IF NOT EXISTS study_agent_memory (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  facts      JSONB DEFAULT '{}',
  summary    TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
