# Study App

An AI-powered study companion built for intensive exam preparation. Combines a PDF-grounded tutor, adaptive quizzes with AI grading, voice conversation mode, and a weekly study planner — all in a clean single-page app with no build step.

**Live demo:** https://bocconi-study-app-production.up.railway.app
**Demo login:** username `demo` · PIN `1234`

---

## Features

- **AI Tutor** — context-aware chat grounded in uploaded lecture slides (PDFs). Streams responses via SSE. Supports multiple Claude models (Sonnet, Haiku, Opus).
- **Voice Mode** — full duplex voice chat using Silero VAD for local voice activity detection, OpenAI Whisper for transcription, and streaming TTS with barge-in support.
- **Adaptive Quizzes** — MCQ bank with AI grading for open-ended questions. Tracks weak areas and surfaces targeted drills.
- **Study Orbit** — a drag-and-drop weekly planner. An AI agent breaks down each course into sessions and schedules them against your exam dates. Supports rescheduling, task chat, and plan regeneration.
- **Listen Mode** — TTS playback of AI-generated course primers. Falls back to browser SpeechSynthesis if no OpenAI key is set.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js + Express |
| Frontend | Vanilla JS ES modules — no framework, no build |
| AI | Anthropic Claude API (chat, grading, planning) |
| Voice | OpenAI Whisper (STT) + TTS · Silero VAD (ONNX, local) |
| Database | Supabase (Postgres) — auth, courses, progress, planner |
| Deploy | Railway |

## Architecture

Minimal Express server acting as a proxy and data layer. The frontend is plain ES modules with event delegation throughout — no React, no bundler, no build step.

```
server.js           Express proxy + Supabase client
public/
├── app.js          Entry: auth init, registers all views
├── router.js       navigate(view, params), mount/unmount lifecycle
├── config.js       Single source of truth: courses, exam dates, models
├── store/          Lightweight pub/sub state
├── lib/            api.js, utils.js, markdown.js, toast.js
├── views/          dashboard, courses, tutor, settings, study-orbit
└── components/     quiz-modal.js, listen-modal.js
```

See [CLAUDE.md](CLAUDE.md) for full endpoint docs and frontend patterns.

## Running locally

```bash
git clone <repo>
cd study-app
npm install
cp .env.example .env   # fill in your keys
npm run dev            # starts with hot-reload on :3000
```

**Required `.env` vars:**

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_ANON_KEY=...
CLAUDE_API_KEY=...      # optional — users can also set their own key in Settings
PORT=3000
```

After signing in, go to **Settings** to save your Anthropic API key (required for AI features) and optionally an OpenAI key (for high-quality TTS + Whisper voice mode).

#project #build
