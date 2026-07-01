# Study App

My AI-powered university exam study tool — generates flashcards, quizzes, and structured revision notes from lecture material, with an autonomous AI study tutor and a "Study Orbit" planner. Built with the Claude API + vanilla JS. **Tie improvements back to my real goal: actually using this to build a consistent revision habit for the Nottingham final year.**

> **Status (27 Jun 2026):** Built; source migrated from Cowork with `node_modules` excluded (reinstall locally to run). `(C)` prefix on Claude-generated files; ask before editing existing app code.

---

## Technical guidance (Claude Code, in-repo)

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev     # Start with hot-reload (node --watch)
npm start       # Production start
```

Requires a `.env` file with `CLAUDE_API_KEY=sk-ant-...` in the project root. No build step — plain Node.js + static files.

## Architecture

Single-page app with a minimal Express server acting as a proxy and file store.

### Server (`server.js`)

Key endpoints:
- `GET /api/courses` — serves `data/courses.json`
- `GET /api/questions` — serves `data/questions.json`
- `GET|POST /api/progress` — reads/writes `data/progress.json`
- `POST /api/chat` — proxies to Anthropic `/v1/messages`
- `POST /api/tts` — proxies to OpenAI TTS
- `POST /api/voice/transcribe` — STT via Whisper
- `POST /api/voice/chat` — SSE-streaming voice reply
- `GET|POST /api/study-orbit` — Study Orbit plan (reads from Supabase)
- `POST /api/study/tasks/:id` — patch task status
- `POST /api/study/tasks/:id/move` — drag-and-drop rescheduling
- `POST /api/study/plan/regenerate` — rebuild the orbit plan
- `POST /api/study/orbit-chat` — SSE-streaming orbit agent

### Frontend (`public/`)

Vanilla JS ES modules — no framework, no build step.

```
public/
├── index.html          — shell: login overlay, nav, modals, view containers
├── app.js              — entry: auth init, registers all views
├── router.js           — navigate(view, params), mount/unmount lifecycle
├── config.js           — SINGLE SOURCE OF TRUTH: courses, exam dates, orbit config, models
├── style.css           — design tokens, component classes (unchanged from monolith)
│
├── store/
│   └── store.js        — state object + emit/on/off/patch
│
├── lib/
│   ├── api.js          — all fetch() calls, orbit mutations with deep-copy rollback
│   ├── utils.js        — escapeHtml, daysUntil, formatOrbitDate, shuffle, etc.
│   ├── markdown.js     — renderMarkdown, inlineMd
│   └── toast.js        — showToast(msg, type)
│
├── views/
│   ├── dashboard/dashboard.js
│   ├── courses/courses.js
│   ├── course-detail/course-detail.js
│   ├── settings/settings.js
│   ├── tutor/
│   │   ├── tutor.js          — layout, sidebar, chat, notes mode, model picker
│   │   └── tutor-voice.js    — Silero VAD, STT, streaming TTS, barge-in
│   └── study-orbit/
│       ├── orbit.js          — orchestrator: mount/unmount, event delegation, state decisions
│       ├── orbit-calendar.js — week grid, day columns, top-task strip (pure render)
│       ├── orbit-card.js     — task card HTML (drag source, pure render)
│       ├── orbit-drawer.js   — task detail side panel (pure render)
│       ├── orbit-wizard.js   — 4-step setup wizard (pure render + value helpers)
│       ├── orbit-setup.js    — preferences/ratings panel (pure render)
│       └── orbit-chat.js     — floating agent chat: own DOM, async, store subscriptions
│
└── components/
    ├── quiz-modal.js   — sets window.openQuiz / openWeakDrill / closeQuiz
    └── listen-modal.js — sets window.openListen / closeListen / ttsPlay / ttsPause / ttsStop
```

### Patterns to follow

- **Event delegation**: all view HTML uses `data-action` + `data-*` attributes; one `container.addEventListener('click', ...)` in mount handles everything. No inline `onclick`.
- **Window globals**: persistent UI in index.html (login, nav, modals) uses inline onclick calling `window.*` set by app.js or component modules.
- **Each view exports `mount(container, params)`** returning an `unmount()` cleanup function.
- **escapeHtml** must be imported from `lib/utils.js` in every module that writes `innerHTML` with user-derived data.
- **Drag-and-drop**: uses `DataTransfer` (not global state). Deep-copy snapshot before optimistic mutation → true rollback on error.
- **Voice**: references `window.ort` and `window.vad` explicitly (they come from pre-module `<script>` tags).

### Data files (`data/`)

- `courses.json` — structured course content: sessions, definitions, concepts, distinctions, examples, keywords
- `questions.json` — MCQ bank keyed by course ID
- `progress.json` — written at runtime; tracks answers and wrong-question lists

### Key details

- All MCQs use the Bocconi "which is NOT correct?" format — one false statement among four options
- ISM and Digital Strategy also include open-ended questions (`type: "open"`) with `model_answer` and `key_points`
- `generate-questions` uses `claude-opus-4-5`; `/api/chat` passes through whatever model the frontend requests
- Exam dates: `server.js COURSE_EXAM_DATES` must stay in sync with `public/config.js COURSES[].examDate`
- No database for courses/progress — flat JSON on disk. Study Orbit uses Supabase (run `db/study-orbit-schema.sql`)
- Chat history: localStorage + synced to server via `/api/conversations/sync`
