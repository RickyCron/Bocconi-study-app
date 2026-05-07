# Database

Supabase project: **Bocconi study app** (`dnlzqjeodehnzhlfckhm`, region `eu-west-1`).
Server connects with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `.env`.

## Files

| File | Purpose |
|---|---|
| `schema.sql` | Canonical schema. Run once on a fresh Supabase project, idempotent (`CREATE TABLE IF NOT EXISTS`). |
| `study-orbit-schema.sql` | Subset of `schema.sql` covering only the Study Orbit planner tables. Use as a fallback when Orbit reports missing tables in the UI. Mirror any changes to the matching section of `schema.sql`. |

## First-time setup

1. Create the Storage bucket `course-slides` in Supabase Dashboard (public read, 50 MB per-file limit).
2. Run `db/schema.sql` in Supabase Dashboard → SQL Editor.
3. Seed reference content from local JSON:

```bash
node scripts/migrate.js       # one-off: imports legacy data/legacy/users.json + progress JSONs
node scripts/seed-courses.js  # imports data/seed/courses/*.json + uploads University Slides PDFs
```

`migrate.js` is a one-shot that ran when the app moved off flat-file storage; the source JSONs now live in `data/legacy/`. `seed-courses.js` is idempotent — safe to re-run any time.

## Tables at a glance

**Auth & users** — `users`, `sessions`
**Per-user state** — `user_progress`, `wrong_questions`, `quiz_answers`, `study_sessions`, `chat_conversations`
**Course content** (public reference data) — `courses`, `course_sessions`, `course_slides`, `course_definitions`, `course_concepts`, `course_distinctions`, `course_examples`, `course_keywords`, `course_questions`
**Study Orbit planner** — `study_preferences`, `study_course_ratings`, `study_resource_links`, `study_plan_days`, `study_plan_tasks`

## Known lint findings

Captured 2026-04-25 via Supabase advisors. Documented here so they aren't re-discovered each audit.

### Security

- **RLS enabled, no policies** on 13 user-scoped tables (`users`, `user_progress`, `wrong_questions`, `quiz_answers`, `study_sessions`, `chat_conversations`, `sessions`, `study_preferences`, `study_course_ratings`, `study_resource_links`, `study_plan_days`, `study_plan_tasks`).
  Intentional. `server.js` uses the service-role key, which bypasses RLS. Anon clients have zero access — exactly what we want for a single-user app behind a Node proxy.
- **RLS disabled** on 9 `course_*` tables and `courses`/`course_sessions`. Lint flags these as ERROR. They're public reference data; if you ever expose anon reads directly (e.g. static frontend without the proxy), enable RLS and add `CREATE POLICY ... FOR SELECT USING (true)`.

### Performance

- **Unindexed FKs** on `course_concepts`, `course_definitions`, `course_distinctions`, `course_examples`, `course_keywords` (all on `course_id`). Low impact (≤ 50 rows per table); add indexes if any of these grow.
- **Unused index** `idx_study_sessions_user`. Cost is negligible; leave it.

## Live migrations

Applied via Supabase MCP / dashboard so far:

- `20260422121729_add_mode_to_chat_conversations`
- `20260422160819_add_conversation_summary_fields`
- `20260422201709_course_content_tables`
- `20260422202047_course_slides_unique_per_session`
