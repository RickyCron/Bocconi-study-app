-- Bocconi Study App — Supabase schema (single source of truth)
-- Run this once in Supabase Dashboard → SQL Editor.
--
-- ── Known lint findings (current as of last audit) ───────────────────────────
-- Security:
--   • 13 user-scoped tables have RLS enabled but no policies
--     (users, user_progress, wrong_questions, quiz_answers, study_sessions,
--      chat_conversations, sessions, study_preferences, study_course_ratings,
--      study_resource_links, study_plan_days, study_plan_tasks).
--     This is intentional — server.js uses the SUPABASE_SERVICE_ROLE_KEY which
--     bypasses RLS. Anon clients have zero access, which is what we want.
--   • 8 course_* tables have RLS DISABLED (course_slides, course_definitions,
--     course_concepts, course_distinctions, course_examples, course_keywords,
--     course_questions, courses, course_sessions). These are public-readable
--     reference data. Lint flags them as ERROR; can be fixed later by enabling
--     RLS + adding a permissive `USING (true)` SELECT policy.
-- Performance:
--   • Unindexed FKs on course_concepts/definitions/distinctions/examples/keywords
--     (course_id) — low impact, ~25–42 rows per table.
--   • idx_study_sessions_user is currently unused. Kept; cost is negligible.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Users (replaces users.json) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username   TEXT UNIQUE NOT NULL,
  pin_hash   TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Auth sessions (cookie-token store written by server.js) ──────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);

-- ── Per-session progress (replaces progress-{username}.json) ──────────────────
CREATE TABLE IF NOT EXISTS user_progress (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  course_id  TEXT NOT NULL,
  session_id TEXT NOT NULL,
  quiz_score INTEGER DEFAULT 0,
  notes_done BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, course_id, session_id)
);

-- ── Wrong questions per course ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wrong_questions (
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  course_id   TEXT NOT NULL,
  added_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, question_id)
);

-- ── Individual quiz answers (drives adaptive learning) ────────────────────────
CREATE TABLE IF NOT EXISTS quiz_answers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  question_id     TEXT NOT NULL,
  course_id       TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  selected_answer TEXT,
  is_correct      BOOLEAN NOT NULL,
  answered_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Study sessions (1-hour check-in tracking) ────────────────────────────────
CREATE TABLE IF NOT EXISTS study_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID REFERENCES users(id) ON DELETE CASCADE,
  started_at         TIMESTAMPTZ DEFAULT NOW(),
  ended_at           TIMESTAMPTZ,
  questions_answered INTEGER DEFAULT 0,
  correct_answers    INTEGER DEFAULT 0,
  courses_touched    TEXT[] DEFAULT '{}'
);

-- ── Chat conversations (replaces localStorage) ───────────────────────────────
CREATE TABLE IF NOT EXISTS chat_conversations (
  id                TEXT PRIMARY KEY,
  user_id           UUID REFERENCES users(id) ON DELETE CASCADE,
  course_id         TEXT NOT NULL,
  title             TEXT DEFAULT 'Conversation',
  messages          JSONB NOT NULL DEFAULT '[]',
  is_draft          BOOLEAN DEFAULT FALSE,
  mode              TEXT DEFAULT 'text',  -- 'text' | 'voice'
  summary           TEXT,                  -- rolling prose summary of messages [0..summarized_up_to)
  summarized_up_to  INTEGER DEFAULT 0,     -- index into messages[] past which nothing is summarised yet
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'text';
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS summarized_up_to INTEGER DEFAULT 0;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_quiz_answers_user_course ON quiz_answers(user_id, course_id);
CREATE INDEX IF NOT EXISTS idx_quiz_answers_question   ON quiz_answers(user_id, question_id);
CREATE INDEX IF NOT EXISTS idx_user_progress_user      ON user_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_convs_user         ON chat_conversations(user_id, course_id);
CREATE INDEX IF NOT EXISTS idx_study_sessions_user     ON study_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_wrong_questions_user    ON wrong_questions(user_id, course_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Course content (replaces data/courses/*.json + iCloud slides folder)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Top-level course metadata
CREATE TABLE IF NOT EXISTS courses (
  id           TEXT PRIMARY KEY,           -- 'gtm', 'geopolitics', 'digital_strategy', 'ibm', 'ism'
  name         TEXT NOT NULL,
  exam_date    TEXT,
  exam_format  TEXT,
  order_idx    INTEGER DEFAULT 0
);

-- Sessions (ext_id like '1-3', '5-8' — referenced by question.session and frontend)
CREATE TABLE IF NOT EXISTS course_sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id  TEXT REFERENCES courses(id) ON DELETE CASCADE,
  ext_id     TEXT NOT NULL,
  title      TEXT NOT NULL,
  topics     JSONB DEFAULT '[]',
  order_idx  INTEGER DEFAULT 0,
  UNIQUE(course_id, ext_id)
);

-- Slide decks (PDFs in Supabase Storage bucket course-slides)
CREATE TABLE IF NOT EXISTS course_slides (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id      TEXT REFERENCES courses(id) ON DELETE CASCADE,
  session_ext_id TEXT,                       -- nullable: unlinked "extras"
  title          TEXT NOT NULL,
  storage_path   TEXT NOT NULL,              -- e.g. 'gtm/bp-sessions-1-3.pdf'
  public_url     TEXT NOT NULL,              -- cached public URL
  file_size_kb   INTEGER,
  source         TEXT DEFAULT 'uploaded',    -- 'migrated' | 'uploaded'
  order_idx      INTEGER DEFAULT 0,
  uploaded_at    TIMESTAMPTZ DEFAULT NOW(),
  -- Same PDF may appear under multiple sessions; uniqueness is per-attachment.
  UNIQUE(course_id, session_ext_id, storage_path)
);

CREATE TABLE IF NOT EXISTS course_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  definition TEXT NOT NULL,
  order_idx INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS course_concepts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  explanation TEXT NOT NULL,
  order_idx INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS course_distinctions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  difference TEXT NOT NULL,
  order_idx INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS course_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  order_idx INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS course_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  order_idx INTEGER DEFAULT 0
);

-- Questions — keeps existing ID format ('gtm-001', 'ism-001'); supports MCQ + open
CREATE TABLE IF NOT EXISTS course_questions (
  id              TEXT PRIMARY KEY,
  course_id       TEXT REFERENCES courses(id) ON DELETE CASCADE,
  session_ext_id  TEXT,
  type            TEXT NOT NULL,            -- 'mcq_not_correct' | 'open'
  question        TEXT NOT NULL,
  options         JSONB,                    -- {a,b,c,d} for MCQ, null for open
  correct_answer  TEXT,                     -- MCQ only
  model_answer    TEXT,                     -- open only
  key_points      JSONB,                    -- open only
  explanation     TEXT,
  order_idx       INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_course_sessions_course   ON course_sessions(course_id, order_idx);
CREATE INDEX IF NOT EXISTS idx_course_slides_course     ON course_slides(course_id, session_ext_id);
CREATE INDEX IF NOT EXISTS idx_course_questions_course  ON course_questions(course_id, order_idx);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Study Orbit planner
-- ═══════════════════════════════════════════════════════════════════════════════

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
