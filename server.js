require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Upload handler for slide deck PDFs — 45 MB cap stays comfortably under the
// Storage bucket's 50 MB per-file limit.
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 45 * 1024 * 1024 },
  fileFilter: (_, file, cb) => cb(null, file.mimetype === 'application/pdf')
});

// ── Supabase client ───────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Course data (backed by Supabase: tables + Storage bucket 'course-slides') ──

const COURSE_IDS = ['gtm', 'geopolitics', 'digital_strategy', 'ibm', 'ism'];

// Serve Silero VAD assets (worklet, onnx models) and onnxruntime-web (wasm, mjs)
// locally so voice mode doesn't depend on CDN availability.
app.use('/vad', express.static(path.join(__dirname, 'node_modules', '@ricky0123', 'vad-web', 'dist')));
app.use('/ort', express.static(path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist')));

// In-memory cache — invalidated on slide upload. Courses rarely change so this
// avoids 9-way DB round-trips on every /api/courses / /api/chat / /api/quiz hit.
let _courseCache = null;
function invalidateCourses() { _courseCache = null; }

async function _fetchCourseFromDb(id) {
  const [c, sess, slides, defs, cons, dists, exs, kws, qs] = await Promise.all([
    supabase.from('courses').select('*').eq('id', id).maybeSingle(),
    supabase.from('course_sessions').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_slides').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_definitions').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_concepts').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_distinctions').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_examples').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_keywords').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_questions').select('*').eq('course_id', id).order('order_idx'),
  ]);
  if (!c.data) return null;

  const slidesBySession = {};
  for (const sl of (slides.data || [])) {
    const key = sl.session_ext_id || '__orphan__';
    (slidesBySession[key] = slidesBySession[key] || []).push({ title: sl.title, file: sl.public_url });
  }

  return {
    id: c.data.id,
    name: c.data.name,
    exam_date: c.data.exam_date,
    exam_format: c.data.exam_format,
    sessions: (sess.data || []).map(s => ({
      id: s.ext_id,
      title: s.title,
      topics: s.topics || [],
      slides: slidesBySession[s.ext_id] || []
    })),
    definitions:  (defs.data || []).map(d => ({ term: d.term, definition: d.definition })),
    concepts:     (cons.data || []).map(x => ({ name: x.name, explanation: x.explanation })),
    distinctions: (dists.data|| []).map(d => ({ a: d.a, b: d.b, difference: d.difference })),
    examples:     (exs.data  || []).map(e => e.text),
    keywords:     (kws.data  || []).map(k => k.keyword),
    questions:    (qs.data   || []).map(q => {
      const out = { id: q.id, session: q.session_ext_id, type: q.type, question: q.question };
      if (q.type === 'open') {
        out.model_answer = q.model_answer;
        out.key_points = q.key_points || [];
      } else {
        out.options = q.options;
        out.correct = q.correct_answer;
      }
      if (q.explanation !== null && q.explanation !== undefined) out.explanation = q.explanation;
      return out;
    })
  };
}

async function loadAllCourses() {
  if (_courseCache) return _courseCache;
  const entries = await Promise.all(COURSE_IDS.map(async id => [id, await _fetchCourseFromDb(id)]));
  _courseCache = Object.fromEntries(entries.filter(([, v]) => v));
  return _courseCache;
}

async function loadCourse(id) {
  const all = await loadAllCourses();
  return all[id] || null;
}

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

// ── Auth helpers ──────────────────────────────────────────────────────────────

const sessionCache = new Map(); // token → username (in-memory cache, loaded from DB on startup)
const userIdCache = new Map();   // username → UUID

function hashPin(username, pin) {
  return crypto.createHash('sha256').update(username.toLowerCase() + ':' + pin).digest('hex');
}

function parseCookies(req) {
  const list = {};
  const header = req.headers.cookie;
  if (!header) return list;
  header.split(';').forEach(part => {
    const [key, ...vals] = part.trim().split('=');
    if (key) list[key.trim()] = decodeURIComponent(vals.join('='));
  });
  return list;
}

function getToken(req) {
  return parseCookies(req).sid || null;
}

// Synchronous lookup — cache is pre-loaded at startup and kept in sync
function getUser(req) {
  const token = getToken(req);
  return token ? sessionCache.get(token) : null;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function createSession(token, username) {
  sessionCache.set(token, username);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await supabase.from('sessions').insert({ token, username, expires_at: expiresAt });
}

async function deleteSession(token) {
  sessionCache.delete(token);
  await supabase.from('sessions').delete().eq('token', token);
}

async function loadSessions() {
  const { data, error } = await supabase
    .from('sessions')
    .select('token, username')
    .gt('expires_at', new Date().toISOString());
  if (error) { console.error('Could not load sessions:', error.message); return; }
  for (const row of data || []) sessionCache.set(row.token, row.username);
  console.log(`✓  Sessions restored (${data?.length || 0} active)`);
}

async function getUserId(username) {
  if (userIdCache.has(username)) return userIdCache.get(username);
  const { data } = await supabase.from('users').select('id').eq('username', username).single();
  if (data) userIdCache.set(username, data.id);
  return data?.id;
}

const userKeysCache = new Map(); // username → { anthropic_key, openai_key }

async function getUserKeys(username) {
  if (userKeysCache.has(username)) return userKeysCache.get(username);
  const { data } = await supabase.from('users').select('anthropic_key, openai_key').eq('username', username).single();
  const keys = { anthropic_key: data?.anthropic_key || '', openai_key: data?.openai_key || '' };
  userKeysCache.set(username, keys);
  return keys;
}

const SESSION_COOKIE = { httpOnly: true, sameSite: 'strict', maxAge: SESSION_TTL_MS };

// ── Progress helpers ──────────────────────────────────────────────────────────

// Convert Supabase rows → legacy progress JSON format expected by frontend
async function getProgressFromDB(userId) {
  const [{ data: progRows }, { data: wrongRows }] = await Promise.all([
    supabase.from('user_progress').select('*').eq('user_id', userId),
    supabase.from('wrong_questions').select('*').eq('user_id', userId)
  ]);

  const progress = {};
  for (const row of progRows || []) {
    if (!progress[row.course_id]) progress[row.course_id] = {};
    progress[row.course_id][row.session_id] = {
      quizScore: row.quiz_score,
      notesDone: row.notes_done
    };
  }
  for (const row of wrongRows || []) {
    if (!progress[row.course_id]) progress[row.course_id] = {};
    if (!progress[row.course_id].wrongQuestions) progress[row.course_id].wrongQuestions = [];
    progress[row.course_id].wrongQuestions.push(row.question_id);
  }
  return progress;
}

// Persist frontend progress JSON → Supabase tables
async function saveProgressToDB(userId, progressBody) {
  const progressUpserts = [];
  const allWrong = [];

  for (const [courseId, courseData] of Object.entries(progressBody)) {
    for (const [sessionId, sessionData] of Object.entries(courseData)) {
      if (sessionId === 'wrongQuestions') {
        for (const qid of sessionData) {
          allWrong.push({ user_id: userId, question_id: qid, course_id: courseId });
        }
        continue;
      }
      if (typeof sessionData !== 'object' || sessionData === null) continue;
      progressUpserts.push({
        user_id: userId,
        course_id: courseId,
        session_id: sessionId,
        quiz_score: sessionData.quizScore ?? 0,
        notes_done: sessionData.notesDone ?? false,
        updated_at: new Date().toISOString()
      });
    }
  }

  const ops = [];
  if (progressUpserts.length > 0) {
    ops.push(supabase.from('user_progress').upsert(progressUpserts, { onConflict: 'user_id,course_id,session_id' }));
  }
  // Replace all wrong questions for this user
  ops.push(
    supabase.from('wrong_questions').delete().eq('user_id', userId).then(() =>
      allWrong.length > 0 ? supabase.from('wrong_questions').insert(allWrong) : Promise.resolve()
    )
  );
  await Promise.all(ops);
}

// ── Study Orbit helpers ──────────────────────────────────────────────────────

const STUDY_ORBIT_TOOLS = ['notes', 'agent', 'quiz', 'canvas', 'schematic', 'mindmap'];
const STUDY_ORBIT_TECHNIQUES = ['notes', 'update', 'deeper', 'quiz', 'video', 'canvas', 'schematic', 'mindmap'];
// SOURCE OF TRUTH: public/config.js — keep in sync with COURSES[].examDate
const COURSE_EXAM_DATES = {
  gtm: '2026-05-18',
  geopolitics: '2026-05-21',
  digital_strategy: '2026-05-22',
  ibm: '2026-05-27',
  ism: '2026-05-27'
};

// Parse "18 May 2026, 11:30 am" → minutes-since-midnight (e.g. 690)
function parseExamTimeMinutes(dateStr) {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(dateStr || '');
  if (!m) return null;
  let h = parseInt(m[1]); const mins = parseInt(m[2]);
  if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
  if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
  return h * 60 + mins;
}

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysKey(key, days) {
  const d = new Date(`${key}T00:00:00`);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

function daysBetween(a, b) {
  const start = new Date(`${a}T00:00:00`);
  const end = new Date(`${b}T00:00:00`);
  return Math.max(0, Math.round((end - start) / 86400000));
}

function parseTimeMinutes(value, fallback) {
  const raw = typeof value === 'string' ? value : fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw || '');
  if (!m) return parseTimeMinutes(fallback || '08:30', '08:30');
  return Math.min(1439, Math.max(0, Number(m[1]) * 60 + Number(m[2])));
}

function formatTimeMinutes(total) {
  const mins = Math.max(0, Math.min(1439, Math.round(total)));
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function snapToSlot(minutes, slot = 15) {
  return Math.round(minutes / slot) * slot;
}

function normalizeRating(value) {
  return ['low', 'medium', 'high'].includes(value) ? value : 'medium';
}

function ratingValue(value) {
  return ({ low: 1, medium: 2, high: 3 })[normalizeRating(value)];
}

function defaultStudyPrefs() {
  return {
    wake_time: '08:30',
    bed_time: '23:30',
    daily_effort: 'medium',
    preferred_techniques: ['notes', 'update', 'deeper', 'quiz'],
    unavailable_blocks: [
      { id: 'breakfast', label: 'Breakfast', start: '08:30', end: '09:15' },
      { id: 'lunch', label: 'Lunch', start: '13:00', end: '14:00' },
      { id: 'dinner', label: 'Dinner', start: '19:30', end: '20:30' },
      { id: 'reset', label: 'Long reset', start: '16:30', end: '17:00' }
    ],
    daily_overrides: {},
    exam_overrides: {}
  };
}

async function ensureStudyPreferences(userId) {
  const { data } = await supabase.from('study_preferences').select('*').eq('user_id', userId).maybeSingle();
  if (data) return data;
  const prefs = defaultStudyPrefs();
  const { data: inserted, error } = await supabase
    .from('study_preferences')
    .insert({ user_id: userId, ...prefs })
    .select()
    .single();
  if (error) throw error;
  return inserted;
}

function normalizeStudyPrefs(body, existing = defaultStudyPrefs()) {
  const preferred = Array.isArray(body.preferredTechniques)
    ? body.preferredTechniques.filter(t => STUDY_ORBIT_TECHNIQUES.includes(t))
    : existing.preferred_techniques || defaultStudyPrefs().preferred_techniques;
  return {
    wake_time: /^(\d{1,2}):\d{2}$/.test(body.wakeTime || '') ? body.wakeTime : existing.wake_time,
    bed_time: /^(\d{1,2}):\d{2}$/.test(body.bedTime || '') ? body.bedTime : existing.bed_time,
    daily_effort: normalizeRating(body.dailyEffort || existing.daily_effort),
    preferred_techniques: preferred.length ? preferred : defaultStudyPrefs().preferred_techniques,
    unavailable_blocks: Array.isArray(body.unavailableBlocks)
      ? body.unavailableBlocks
      : (Array.isArray(existing.unavailable_blocks) && existing.unavailable_blocks.length
        ? existing.unavailable_blocks
        : defaultStudyPrefs().unavailable_blocks),
    daily_overrides: body.dailyOverrides && typeof body.dailyOverrides === 'object'
      ? body.dailyOverrides
      : (existing.daily_overrides || {}),
    exam_overrides: body.examOverrides && typeof body.examOverrides === 'object'
      ? body.examOverrides
      : (existing.exam_overrides || {})
  };
}

function clientPrefs(row) {
  const prefs = row || defaultStudyPrefs();
  return {
    wakeTime: prefs.wake_time || '08:30',
    bedTime: prefs.bed_time || '23:30',
    dailyEffort: prefs.daily_effort || 'medium',
    preferredTechniques: prefs.preferred_techniques || defaultStudyPrefs().preferred_techniques,
    unavailableBlocks: prefs.unavailable_blocks || [],
    dailyOverrides: prefs.daily_overrides || {},
    examOverrides: prefs.exam_overrides || {}
  };
}

function ratingFor(ratingsByKey, courseId, sessionId) {
  const course = ratingsByKey.get(`${courseId}:__course__`) || {};
  const session = ratingsByKey.get(`${courseId}:${sessionId}`) || {};
  return {
    slide_load: normalizeRating(session.slide_load || course.slide_load),
    lecture_depth: normalizeRating(session.lecture_depth || course.lecture_depth),
    required_depth: normalizeRating(session.required_depth || course.required_depth),
    syllabus_difficulty: normalizeRating(session.syllabus_difficulty || course.syllabus_difficulty),
    effort: normalizeRating(session.effort || course.effort)
  };
}

function inferredRatingFor(course, session, quizScore = null) {
  const slideCount = (session.slides || []).length;
  const topicText = `${session.title || ''} ${(session.topics || []).join(' ')}`.toLowerCase();
  const hardWords = ['strategy', 'model', 'framework', 'analysis', 'market', 'financial', 'geopolitics', 'platform', 'digital', 'competitive', 'case'];
  const hardHits = hardWords.filter(w => topicText.includes(w)).length;
  const qWeak = quizScore !== null && quizScore < 70;
  const high = slideCount >= 2 || hardHits >= 3 || qWeak;
  const low = slideCount <= 1 && hardHits <= 1 && !qWeak;
  const level = high ? 'high' : low ? 'low' : 'medium';
  return {
    slide_load: slideCount >= 2 ? 'high' : 'medium',
    lecture_depth: level,
    required_depth: high ? 'high' : 'medium',
    syllabus_difficulty: level,
    effort: high ? 'high' : 'medium'
  };
}

function mergedRating(ratingsByKey, courseId, course, session, quizScore) {
  const inferred = inferredRatingFor(course, session, quizScore);
  const courseRating = ratingsByKey.get(`${courseId}:__course__`) || {};
  const sessionRating = ratingsByKey.get(`${courseId}:${session.id}`) || {};
  return {
    slide_load: sessionRating.slide_load || courseRating.slide_load || inferred.slide_load,
    lecture_depth: sessionRating.lecture_depth || courseRating.lecture_depth || inferred.lecture_depth,
    required_depth: sessionRating.required_depth || courseRating.required_depth || inferred.required_depth,
    syllabus_difficulty: sessionRating.syllabus_difficulty || courseRating.syllabus_difficulty || inferred.syllabus_difficulty,
    effort: sessionRating.effort || courseRating.effort || inferred.effort,
    inferred
  };
}

async function getQuizStats(userId) {
  const { data } = await supabase
    .from('quiz_answers')
    .select('course_id, session_id, is_correct')
    .eq('user_id', userId);
  const stats = new Map();
  for (const row of data || []) {
    const key = `${row.course_id}:${row.session_id || 'unknown'}`;
    const cur = stats.get(key) || { total: 0, correct: 0 };
    cur.total += 1;
    if (row.is_correct) cur.correct += 1;
    stats.set(key, cur);
  }
  return stats;
}

function orbitStagePlan(rating) {
  const high = rating.required_depth === 'high' || rating.lecture_depth === 'high' || rating.syllabus_difficulty === 'high';
  const low = rating.required_depth === 'low' && rating.lecture_depth === 'low' && rating.syllabus_difficulty === 'low';
  if (low) return ['first_pass', 'retrieval', 'spaced_review'];
  if (high) return ['first_pass', 'knowledge_update', 'deep_work', 'retrieval', 'spaced_review'];
  return ['first_pass', 'knowledge_update', 'retrieval', 'spaced_review'];
}

function orbitStageMeta(stage, session, rating, quizScore, resource) {
  const lecture = `Lecture ${session.id}: ${session.title}`;
  const difficulty = `${rating.syllabus_difficulty} difficulty, ${rating.required_depth} required depth`;
  if (stage === 'first_pass') {
    return {
      task_type: 'first_pass',
      tool: 'notes',
      title: `${lecture} - first pass notes`,
      duration_minutes: 50,
      block_kind: 'focus',
      reasoning: `Start with the earliest unfinished lecture. Build the foundation first: read the slides, write notes, and mark unclear ideas. ${difficulty}.`
    };
  }
  if (stage === 'knowledge_update') {
    return {
      task_type: 'knowledge_update',
      tool: 'agent',
      title: `${lecture} - update knowledge`,
      duration_minutes: 50,
      block_kind: 'focus',
      reasoning: `Turn first-pass notes into clean understanding before moving forward. Use the agent to fill gaps and create active recall prompts. ${difficulty}.`
    };
  }
  if (stage === 'deep_work') {
    return {
      task_type: 'deep_work',
      tool: rating.required_depth === 'high' ? 'schematic' : 'mindmap',
      title: `${lecture} - deep structure`,
      duration_minutes: 75,
      block_kind: 'deep',
      reasoning: `This lecture is rated high-depth or difficult, so it gets a schematic/mindmap block before quizzing. ${difficulty}.`
    };
  }
  if (stage === 'retrieval') {
    return {
      task_type: 'retrieval',
      tool: 'quiz',
      title: `${lecture} - quiz without notes`,
      duration_minutes: quizScore !== null && quizScore < 70 ? 35 : 25,
      block_kind: 'light',
      reasoning: quizScore !== null
        ? `Retrieval locks the lecture into memory. Last quiz signal is ${quizScore}%, so this checks what actually stuck.`
        : 'Retrieval comes after understanding work, because testing yourself is stronger than rereading.'
    };
  }
  return {
    task_type: 'spaced_review',
    tool: resource ? 'agent' : 'quiz',
    title: `${lecture} - spaced review`,
    duration_minutes: 25,
    block_kind: 'light',
    reasoning: 'A short spaced review keeps the lecture alive after the first learning pass and catches weak points before the exam.',
    resource_url: resource?.url || null
  };
}

function buildStudyBacklog({ courses, progress, ratingsByKey, resources, quizStats, completedKeys, scheduledKeys, today }) {
  const resourceBySession = new Map();
  for (const r of resources || []) {
    const key = `${r.course_id}:${r.session_id || '__course__'}`;
    if (!resourceBySession.has(key)) resourceBySession.set(key, r);
  }

  const courseQueues = [];
  for (const [courseId, course] of Object.entries(courses)) {
    const examDate = COURSE_EXAM_DATES[courseId] || '2026-05-27';
    const daysLeft = Math.max(1, daysBetween(today, examDate));
    const courseProgress = progress[courseId] || {};
    const wrongCount = (courseProgress.wrongQuestions || []).length;
    const queue = [];
    let courseLoad = 0;

    for (const session of course.sessions || []) {
      const sessionProgress = courseProgress[session.id] || {};
      const quiz = quizStats.get(`${courseId}:${session.id}`);
      const quizScore = sessionProgress.quizScore ?? (quiz?.total ? Math.round((quiz.correct / quiz.total) * 100) : null);
      const rating = mergedRating(ratingsByKey, courseId, course, session, quizScore);
      const ratingLoad = ratingValue(rating.slide_load) + ratingValue(rating.lecture_depth) + ratingValue(rating.required_depth) + ratingValue(rating.syllabus_difficulty) + ratingValue(rating.effort);
      const slideCount = Math.max(1, (session.slides || []).length);
      const res = resourceBySession.get(`${courseId}:${session.id}`) || resourceBySession.get(`${courseId}:__course__`);
      courseLoad += ratingLoad + slideCount;

      for (const stage of orbitStagePlan(rating)) {
        const generatedKey = `${courseId}:${session.id}:${stage}`;
        if (completedKeys.has(generatedKey) || scheduledKeys.has(generatedKey)) continue;
        const meta = orbitStageMeta(stage, session, rating, quizScore, res);
        const weakBoost = quizScore !== null && quizScore < 70 && (stage === 'retrieval' || stage === 'spaced_review') ? 18 : 0;
        queue.push({
          ...meta,
          user_id: null,
          course_id: courseId,
          session_id: session.id,
          priority: (160 / daysLeft) + (ratingLoad * 3) + (slideCount * 4) + weakBoost + Math.min(18, wrongCount * 2),
          generated_key: generatedKey,
          stage,
          exam_date: examDate,
          session_title: session.title
        });
      }
    }

    if (queue.length) {
      courseQueues.push({
        course_id: courseId,
        exam_date: examDate,
        days_left: daysLeft,
        load: courseLoad,
        queue,
        cursor: 0,
        weight: (180 / daysLeft) + Math.min(80, courseLoad * 2)
      });
    }
  }

  const tasks = [];
  let lastCourse = null;
  while (courseQueues.some(q => q.cursor < q.queue.length)) {
    const available = courseQueues
      .filter(q => q.cursor < q.queue.length)
      .sort((a, b) => {
        const aPenalty = a.course_id === lastCourse ? 28 : 0;
        const bPenalty = b.course_id === lastCourse ? 28 : 0;
        return (b.weight + b.queue[b.cursor].priority - bPenalty) - (a.weight + a.queue[a.cursor].priority - aPenalty);
      });
    const chosen = available[0];
    const next = chosen.queue[chosen.cursor++];
    tasks.push(next);
    lastCourse = chosen.course_id;
  }

  return tasks;
}

function effortCapMinutes(effort, available) {
  const cap = ({ low: 180, medium: 300, high: 420 })[normalizeRating(effort)];
  return Math.max(90, Math.min(cap, Math.floor(available * 0.72)));
}

function breakAfter(kind, heavyCount) {
  if (heavyCount >= 3) return 25;
  if (kind === 'deep') return 15;
  if (kind === 'light') return 5;
  return 10;
}

function normalizeBreakBlocks(prefs, dayOverride = {}) {
  const base = Array.isArray(prefs.unavailable_blocks) && prefs.unavailable_blocks.length
    ? prefs.unavailable_blocks
    : defaultStudyPrefs().unavailable_blocks;
  const extra = Array.isArray(dayOverride.breaks) ? dayOverride.breaks : [];
  return [...base, ...extra]
    .filter(b => b && b.start && b.end)
    .map((b, i) => ({
      id: b.id || `fixed-${i}`,
      label: b.label || 'Long break',
      start: parseTimeMinutes(b.start, '12:00'),
      end: parseTimeMinutes(b.end, '13:00')
    }))
    .filter(b => b.end > b.start)
    .sort((a, b) => a.start - b.start);
}

function pushThroughFixedBreaks(cursor, duration, fixedBreaks) {
  for (const br of fixedBreaks) {
    if (cursor >= br.start && cursor < br.end) return br.end;
    if (cursor < br.start && cursor + duration > br.start) return br.end;
  }
  return cursor;
}

function availableStudyMinutes(wakeMin, bedMin, fixedBreaks, dayOverride, prefs) {
  if (dayOverride.studyMinutes || dayOverride.study_minutes) {
    return Math.max(30, Number(dayOverride.studyMinutes || dayOverride.study_minutes) || 0);
  }
  const breakTotal = fixedBreaks.reduce((sum, br) => {
    const overlap = Math.max(0, Math.min(bedMin, br.end) - Math.max(wakeMin, br.start));
    return sum + overlap;
  }, 0);
  return Math.max(60, Math.floor((bedMin - wakeMin - breakTotal) * 0.68));
}

function dayExplanation(dayTasks, courses, planDate) {
  const studyTasks = dayTasks.filter(t => t.task_type !== 'break');
  const courseNames = [...new Set(studyTasks.map(t => courses[t.course_id]?.name || t.course_id))];
  if (!studyTasks.length) return 'This day is mostly buffer because the core backlog is clear or the day has limited available study time.';
  return `This day starts from the earliest unfinished lecture stages, then weights courses by exam distance. ${courseNames.join(', ')} appear because their next lecture stage is due and their exam pressure/load is highest for ${planDate}. Breaks are inserted after every block so the plan stays realistic.`;
}

// Ensures every stage of a session has a completed record in study_plan_tasks.
// study_plan_tasks only contains SCHEDULED tasks. If a stage was never scheduled
// (it was in the backlog but never placed on a day), it has no row here and therefore
// won't appear in completedKeys — causing it to reappear in future replans.
// This function inserts completion stubs for any missing stages.
async function ensureStagesMarkedComplete(userId, courseId, sessionId, dayId) {
  const courses = await loadAllCourses();
  const course = courses[courseId];
  const session = (course?.sessions || []).find(s => String(s.id) === String(sessionId));
  if (!session) return;

  const ratings = await supabase.from('study_course_ratings').select('*').eq('user_id', userId).then(r => r.data || []);
  const ratingsByKey = new Map(ratings.map(r => [`${r.course_id}:${r.session_id || '__course__'}`, r]));
  const rating = mergedRating(ratingsByKey, courseId, course, session, null);
  const stages = orbitStagePlan(rating);

  // Find which stages already have completion records
  const { data: existing } = await supabase.from('study_plan_tasks')
    .select('generated_key, status')
    .eq('user_id', userId)
    .eq('course_id', courseId)
    .eq('session_id', String(sessionId));
  const completedSet = new Set((existing || []).filter(r => r.status === 'completed').map(r => r.generated_key).filter(Boolean));

  const toInsert = [];
  for (const stage of stages) {
    const generatedKey = `${courseId}:${sessionId}:${stage}`;
    if (!completedSet.has(generatedKey)) {
      const meta = orbitStageMeta(stage, session, rating, null, null);
      toInsert.push({
        user_id: userId,
        day_id: dayId,
        course_id: courseId,
        session_id: String(sessionId),
        task_type: stage,
        tool: STUDY_ORBIT_TOOLS.includes(meta.tool) ? meta.tool : 'agent',
        title: meta.title,
        duration_minutes: meta.duration_minutes,
        start_time: '00:00',
        end_time: '00:00',
        generated_key: generatedKey,
        status: 'completed',
        completed_at: new Date().toISOString()
      });
    }
  }
  if (toInsert.length) {
    await supabase.from('study_plan_tasks').insert(toInsert);
  }
}

// Per-user replan lock — prevents concurrent requests both inserting a full backlog
const _replanLocks = new Map();

async function regenerateStudyPlan(userId, opts = {}) {
  // Serialise replans per user. If one is already running, wait for it to finish
  // before starting another (avoids the concurrent-insert duplicate problem).
  while (_replanLocks.get(userId)) await _replanLocks.get(userId);
  let _resolve;
  const lock = new Promise(r => { _resolve = r; });
  _replanLocks.set(userId, lock);
  try {
    return await _doRegenerateStudyPlan(userId, opts);
  } finally {
    _replanLocks.delete(userId);
    _resolve();
  }
}

async function _doRegenerateStudyPlan(userId, opts = {}) {
  const today = dateKey();
  const fromDate = opts.fromDate || today;
  const todayFillMode = opts.todayFillMode || null;
  const todayFillCourse = opts.todayFillCourse || null;
  const todayFillSession = opts.todayFillSession ? String(opts.todayFillSession) : null;
  // Extra keys to treat as "done" in the backlog — prevents re-scheduling tasks
  // that are currently pending on a preserved day (e.g. today when fromDate=tomorrow).
  const extraExcludeKeys = opts.extraExcludeKeys instanceof Set ? opts.extraExcludeKeys : new Set();
  // Task UUIDs to preserve during the delete phase (e.g. a task we just moved to a target day).
  const protectedTaskIds = Array.isArray(opts.protectedTaskIds) ? opts.protectedTaskIds : [];
  const courses = await loadAllCourses();
  const prefs = await ensureStudyPreferences(userId);
  const progress = await getProgressFromDB(userId);
  const [{ data: ratings }, { data: resources }, { data: completedRows }, { data: existingDays }] = await Promise.all([
    supabase.from('study_course_ratings').select('*').eq('user_id', userId),
    supabase.from('study_resource_links').select('*'),
    supabase.from('study_plan_tasks').select('generated_key, start_time, end_time, course_id, session_id, task_type, tool, title, reasoning, resource_url, duration_minutes, status, study_plan_days!inner(plan_date)').eq('user_id', userId).eq('status', 'completed'),
    supabase.from('study_plan_days').select('id, plan_date').eq('user_id', userId).gte('plan_date', fromDate)
  ]);

  const ratingsByKey = new Map((ratings || []).map(r => [`${r.course_id}:${r.session_id || '__course__'}`, r]));
  const completedKeys = new Set((completedRows || []).filter(r => r.generated_key).map(r => r.generated_key));
  console.log(`[replan] fromDate=${fromDate} completedKeys=${completedKeys.size} existingDays=${(existingDays||[]).length} courses=${Object.keys(courses).length}`);
  // scheduledKeys was previously derived only from completedRows (which had no future-completed tasks
  // and so was always empty). It is now unused — the backlog index enforces single-scheduling.
  const scheduledKeys = new Set();
  const quizStats = await getQuizStats(userId);
  // Merge any caller-supplied extra-exclude keys (e.g. today's pending tasks when fromDate=tomorrow,
  // so they don't get double-scheduled on future days).
  const effectiveCompletedKeys = extraExcludeKeys.size
    ? new Set([...completedKeys, ...extraExcludeKeys])
    : completedKeys;
  const backlog = buildStudyBacklog({ courses, progress, ratingsByKey, resources: resources || [], quizStats, completedKeys: effectiveCompletedKeys, scheduledKeys, today });
  console.log(`[replan] backlog size=${backlog.length} scheduledKeys=${scheduledKeys.size}`);

  // Merge hardcoded exam dates with per-user overrides (date and/or time)
  const examOverrides = prefs.exam_overrides || {};
  const effectiveExamDates = { ...COURSE_EXAM_DATES };
  for (const [cid, ov] of Object.entries(examOverrides)) {
    if (ov?.date) effectiveExamDates[cid] = ov.date;
  }

  const maxExam = Object.values(effectiveExamDates).sort().at(-1) || today;
  const dayCount = daysBetween(fromDate, maxExam) + 1;
  const overrides = prefs.daily_overrides || {};

  // Build a map of exam date → list of exams that day (for special day handling)
  const examsByDate = {};
  for (const [cid, examDateStr] of Object.entries(effectiveExamDates)) {
    const course = courses[cid];
    const examOv = examOverrides[cid];
    // Use user-supplied time override first, then parse from course string, else null
    const timeMin = examOv?.time
      ? parseTimeMinutes(examOv.time, '09:00')
      : parseExamTimeMinutes(course?.exam_date);
    const endTimeMin = examOv?.endTime ? parseTimeMinutes(examOv.endTime, '12:00') : null;
    const durationMin = (endTimeMin && timeMin != null && endTimeMin > timeMin)
      ? endTimeMin - timeMin
      : 90;
    if (!examsByDate[examDateStr]) examsByDate[examDateStr] = [];
    examsByDate[examDateStr].push({ courseId: cid, timeMin, durationMin });
  }

  const futureDayIds = (existingDays || []).map(d => d.id);
  if (futureDayIds.length) {
    let deleteQ = supabase.from('study_plan_tasks').delete().in('day_id', futureDayIds).neq('status', 'completed');
    // Exclude protected task IDs (e.g. a task just moved to a target day) from deletion.
    for (const id of protectedTaskIds) deleteQ = deleteQ.neq('id', id);
    await deleteQ;
  }

  const completedByDate = new Map();
  for (const row of completedRows || []) {
    const planDate = row.study_plan_days?.plan_date;
    if (!planDate || planDate < today) continue;
    if (!completedByDate.has(planDate)) completedByDate.set(planDate, []);
    completedByDate.get(planDate).push(row);
  }

  let backlogIdx = 0;
  for (let i = 0; i < dayCount; i++) {
    const planDate = addDaysKey(fromDate, i);
    const dayOverride = overrides[planDate] || {};
    const wake = dayOverride.wakeTime || dayOverride.wake_time || prefs.wake_time || '08:30';
    const bed = dayOverride.bedTime || dayOverride.bed_time || prefs.bed_time || '23:30';
    const wakeMin = parseTimeMinutes(wake, '08:30');
    let bedMin = parseTimeMinutes(bed, '23:30');
    if (bedMin <= wakeMin + 90) bedMin = Math.min(1439, wakeMin + 240);
    const fixedBreaks = normalizeBreakBlocks(prefs, dayOverride);

    // Exam day: clamp study window, inject rest block and exam task
    const examsToday = examsByDate[planDate] || [];
    const REST_BEFORE_EXAM = 60; // minutes of buffer before exam starts
    const examInjectedTasks = [];
    for (const exam of examsToday) {
      if (exam.timeMin != null) {
        const restStart = exam.timeMin - REST_BEFORE_EXAM;
        const examEnd = exam.timeMin + exam.durationMin;
        bedMin = Math.min(bedMin, restStart - 10);
        fixedBreaks.push({ id: `pre-exam-${exam.courseId}`, label: 'Pre-exam rest', start: restStart, end: exam.timeMin });
        examInjectedTasks.push({
          user_id: userId,
          course_id: exam.courseId,
          session_id: null,
          start_time: formatTimeMinutes(exam.timeMin),
          end_time: formatTimeMinutes(examEnd),
          duration_minutes: exam.durationMin,
          task_type: 'exam',
          tool: 'exam',
          title: `${courses[exam.courseId]?.name || exam.courseId} — EXAM`,
          reasoning: 'Exam block. No study tasks during this period.',
          resource_url: null,
          generated_key: `${planDate}:${exam.courseId}:exam`,
          status: 'pending'
        });
      }
    }

    const available = availableStudyMinutes(wakeMin, bedMin, fixedBreaks, dayOverride, prefs);
    const cap = Math.min(effortCapMinutes(prefs.daily_effort, bedMin - wakeMin), available);
    const locked = completedByDate.get(planDate) || [];
    const lockedEnd = locked.reduce((max, t) => Math.max(max, parseTimeMinutes(t.end_time, wake)), wakeMin);
    let cursor = snapToSlot(Math.max(wakeMin + 15, lockedEnd ? lockedEnd + 10 : wakeMin + 15));
    // For today, never schedule in the past — start from now if cursor has already passed
    if (planDate === today) {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes() + 5;
      if (nowMin > cursor) cursor = snapToSlot(nowMin);
    }
    let used = locked.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);
    const newTasks = [...examInjectedTasks];
    let heavyCount = 0;
    let lastCourse = locked.at(-1)?.course_id || null;
    console.log(`[replan] day=${planDate} locked=${locked.length} used=${used} cap=${Math.min(effortCapMinutes(prefs.daily_effort, bedMin - wakeMin), availableStudyMinutes(wakeMin, bedMin, fixedBreaks, dayOverride, prefs))} cursor=${formatTimeMinutes(cursor)} backlogRemaining=${backlog.length - backlogIdx}`);

    const skipCourses = new Set(dayOverride.skipCourses || []);
    const deferredTasks = [];
    while (backlogIdx < backlog.length && used < cap && cursor < bedMin - 20) {
      const task = backlog[backlogIdx];
      if (skipCourses.has(task.course_id)) {
        // Collect without permanently consuming — re-insert after this day's loop
        // so these tasks remain available for future days.
        deferredTasks.push(task);
        backlogIdx++;
        continue;
      }
      // fill_mode filter: only applies to today (fromDate). Deferred tasks re-enter
      // the backlog for future days via the splice at the end of the loop.
      if (planDate === fromDate && todayFillMode) {
        const sessionMatch = task.course_id === todayFillCourse &&
          String(task.session_id) === todayFillSession &&
          task.task_type !== 'first_pass';
        const passes =
          (todayFillMode === 'consolidate' && sessionMatch) ||
          (todayFillMode === 'progress' && task.course_id === todayFillCourse) ||
          (todayFillMode === 'switch' && task.course_id !== todayFillCourse);
        if (!passes) {
          deferredTasks.push(task);
          backlogIdx++;
          continue;
        }
      }
      if (lastCourse === task.course_id && heavyCount >= 2) {
        const altIdx = backlog.findIndex((t, idx) => {
          if (idx <= backlogIdx || t.course_id === lastCourse || skipCourses.has(t.course_id)) return false;
          if (planDate === fromDate && todayFillMode) {
            const sessionMatch = t.course_id === todayFillCourse && String(t.session_id) === todayFillSession && t.task_type !== 'first_pass';
            if (!(
              (todayFillMode === 'consolidate' && sessionMatch) ||
              (todayFillMode === 'progress' && t.course_id === todayFillCourse) ||
              (todayFillMode === 'switch' && t.course_id !== todayFillCourse)
            )) return false;
          }
          return true;
        });
        if (altIdx !== -1) [backlog[backlogIdx], backlog[altIdx]] = [backlog[altIdx], backlog[backlogIdx]];
      }
      const chosen = backlog[backlogIdx];
      const duration = Math.min(chosen.duration_minutes, Math.max(20, bedMin - cursor));
      const rest = breakAfter(chosen.block_kind, heavyCount + (chosen.block_kind === 'deep' ? 1 : 0));
      cursor = pushThroughFixedBreaks(cursor, duration, fixedBreaks);
      if (used + duration > cap || cursor + duration > bedMin - 10) break;
      backlogIdx += 1;
      const start = snapToSlot(cursor);
      const end = start + duration;
      newTasks.push({
        user_id: userId,
        course_id: chosen.course_id,
        session_id: chosen.session_id,
        start_time: formatTimeMinutes(start),
        end_time: formatTimeMinutes(end),
        duration_minutes: duration,
        task_type: chosen.task_type,
        tool: STUDY_ORBIT_TOOLS.includes(chosen.tool) ? chosen.tool : 'agent',
        title: chosen.title,
        reasoning: chosen.reasoning,
        resource_url: chosen.resource_url,
        generated_key: chosen.generated_key,
        status: 'pending'
      });
      used += duration;
      cursor = snapToSlot(end + rest);
      heavyCount = chosen.block_kind === 'deep' || chosen.block_kind === 'focus' ? heavyCount + 1 : 0;
      lastCourse = chosen.course_id;
    }
    // Re-insert tasks deferred due to skipCourses so they're available for future days.
    if (deferredTasks.length) backlog.splice(backlogIdx, 0, ...deferredTasks);

    console.log(`[replan] day=${planDate} newTasks=${newTasks.length} used_after=${used} backlogIdx=${backlogIdx}`);
    if (!newTasks.length && !locked.length && backlogIdx >= backlog.length) {
      const reviewCourseId = Object.keys(courses).sort((a, b) => daysBetween(planDate, effectiveExamDates[a] || COURSE_EXAM_DATES[a]) - daysBetween(planDate, effectiveExamDates[b] || COURSE_EXAM_DATES[b]))[0];
      if (reviewCourseId) {
        newTasks.push({
          user_id: userId,
          course_id: reviewCourseId,
          session_id: null,
          start_time: formatTimeMinutes(wakeMin + 30),
          end_time: formatTimeMinutes(wakeMin + 75),
          duration_minutes: 45,
          task_type: 'mixed-review',
          tool: 'canvas',
          title: `Mixed review for ${courses[reviewCourseId].name}`,
          reasoning: 'Core backlog is clear; keep memory warm with a light canvas-style review.',
          resource_url: null,
          generated_key: `${planDate}:${reviewCourseId}:mixed-review`,
          status: 'pending'
        });
      }
    }

    const summary = {
      plannedMinutes: used,
      availableStudyMinutes: cap,
      longBreaks: fixedBreaks.map(b => ({ label: b.label, start: formatTimeMinutes(b.start), end: formatTimeMinutes(b.end) })),
      taskCount: locked.length + newTasks.length,
      backlogRemaining: Math.max(0, backlog.length - backlogIdx),
      explanation: dayExplanation([...locked, ...newTasks], courses, planDate)
    };
    const { data: day, error: dayErr } = await supabase
      .from('study_plan_days')
      .upsert({
        user_id: userId,
        plan_date: planDate,
        wake_time: wake,
        bed_time: bed,
        effort_level: prefs.daily_effort,
        summary,
        generated_at: new Date().toISOString()
      }, { onConflict: 'user_id,plan_date' })
      .select()
      .single();
    if (dayErr) throw dayErr;
    if (newTasks.length) {
      await supabase.from('study_plan_tasks').insert(newTasks.map(t => ({ ...t, day_id: day.id })));
    }
  }
}

// Safety net: remove duplicate tasks by generated_key (keeps the first occurrence).
// Duplicates can arise from concurrent replan requests before the per-user lock was added.
function _dedupTasks(tasks) {
  const seen = new Set();
  return tasks.filter(t => {
    if (!t.generated_key) return true; // breaks / exams without a key — always keep
    if (seen.has(t.generated_key)) return false;
    seen.add(t.generated_key);
    return true;
  });
}

function withOrbitBreaks(tasks, planDate, fixedBreaks = []) {
  const sorted = [...tasks].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const task = sorted[i];
    out.push(task);
    const next = sorted[i + 1];
    if (!next) continue;
    const end = parseTimeMinutes(task.end_time, task.start_time);
    const nextStart = parseTimeMinutes(next.start_time, next.end_time);
    const gap = nextStart - end;
    if (gap >= 5) {
      const overlapsFixed = fixedBreaks.some(br => parseTimeMinutes(br.start, '00:00') < nextStart && parseTimeMinutes(br.end, '00:00') > end);
      if (overlapsFixed) continue;
      out.push({
        id: `break-${planDate}-${i}`,
        course_id: 'break',
        session_id: null,
        start_time: formatTimeMinutes(end),
        end_time: formatTimeMinutes(nextStart),
        duration_minutes: gap,
        task_type: gap >= 20 ? 'long_break' : 'break',
        tool: 'break',
        title: gap >= 20 ? 'Long break' : 'Break',
        reasoning: 'Breaks are part of the plan so focus blocks stay realistic and sustainable.',
        resource_url: null,
        status: 'break',
        generated_key: `break:${planDate}:${i}`
      });
    }
  }
  return out;
}

function addFixedOrbitBreaks(tasks, longBreaks = [], planDate) {
  const out = [...tasks];
  for (const [i, br] of (longBreaks || []).entries()) {
    out.push({
      id: `fixed-break-${planDate}-${i}`,
      course_id: 'break',
      session_id: null,
      start_time: br.start,
      end_time: br.end,
      duration_minutes: Math.max(0, parseTimeMinutes(br.end, br.start) - parseTimeMinutes(br.start, br.end)),
      task_type: 'long_break',
      tool: 'break',
      title: br.label || 'Long break',
      reasoning: 'This is protected non-study time so the timetable does not assume you work all day.',
      resource_url: null,
      status: 'break',
      generated_key: `fixed-break:${planDate}:${i}`
    });
  }
  return out.sort((a, b) => a.start_time.localeCompare(b.start_time));
}

async function getStudyOrbitPayload(userId) {
  const prefs = await ensureStudyPreferences(userId);
  const [{ data: ratings }, { data: resources }, { data: days }] = await Promise.all([
    supabase.from('study_course_ratings').select('*').eq('user_id', userId).order('course_id'),
    supabase.from('study_resource_links').select('*').order('course_id'),
    supabase.from('study_plan_days')
      .select('*, study_plan_tasks(*)')
      .eq('user_id', userId)
      .gte('plan_date', dateKey())
      .order('plan_date', { ascending: true })
      .limit(45)
  ]);

  const today = dateKey();
  const hasFuture = (days || []).some(d => d.plan_date >= today);
  if (!hasFuture) {
    await regenerateStudyPlan(userId, { fromDate: today });
    return getStudyOrbitPayload(userId);
  }

  return {
    today,
    setupComplete: prefs.setup_complete === true,
    preferences: clientPrefs(prefs),
    ratings: (ratings || []).map(r => ({
      id: r.id,
      courseId: r.course_id,
      sessionId: r.session_id,
      slideLoad: r.slide_load,
      lectureDepth: r.lecture_depth,
      requiredDepth: r.required_depth,
      syllabusDifficulty: r.syllabus_difficulty,
      effort: r.effort
    })),
    resources: resources || [],
    days: (days || []).map(d => ({
      id: d.id,
      date: d.plan_date,
      wakeTime: d.wake_time,
      bedTime: d.bed_time,
      effortLevel: d.effort_level,
      summary: d.summary || {},
      tasks: addFixedOrbitBreaks(withOrbitBreaks(_dedupTasks(d.study_plan_tasks || []), d.plan_date, d.summary?.longBreaks || []), d.summary?.longBreaks || [], d.plan_date)
        .sort((a, b) => a.start_time.localeCompare(b.start_time))
        .map(t => ({
          id: t.id,
          courseId: t.course_id,
          sessionId: t.session_id,
          scheduledDate: d.plan_date,
          startTime: t.start_time,
          endTime: t.end_time,
          durationMinutes: t.duration_minutes,
          taskType: t.task_type,
          stage: t.task_type,
          tool: t.tool,
          title: t.title,
          reasoning: t.reasoning,
          why: t.reasoning,
          resourceUrl: t.resource_url,
          status: t.status,
          generatedKey: t.generated_key,
          priority: 0,
          movable: t.status !== 'break' && t.task_type !== 'exam'
        }))
    }))
  };
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

app.get('/api/auth/me', (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username });
});

app.post('/api/auth/check', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const { data } = await supabase.from('users').select('id').ilike('username', username).maybeSingle();
  res.json({ exists: !!data });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ error: 'Username and PIN required' });
  const { data: user } = await supabase.from('users').select('*').ilike('username', username).maybeSingle();
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (user.pin_hash !== hashPin(user.username, pin)) return res.status(401).json({ error: 'Incorrect PIN' });
  const token = crypto.randomBytes(32).toString('hex');
  userIdCache.set(user.username, user.id);
  await createSession(token, user.username);
  res.cookie('sid', token, SESSION_COOKIE);
  res.json({ username: user.username });
});

app.post('/api/auth/register', async (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ error: 'Username and PIN required' });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 digits' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Username must be 2–20 characters' });

  const { data: existing } = await supabase.from('users').select('id').ilike('username', username).maybeSingle();
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const { data: newUser, error } = await supabase
    .from('users')
    .insert({ username, pin_hash: hashPin(username, pin) })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'Could not create account' });

  userIdCache.set(newUser.username, newUser.id);
  const token = crypto.randomBytes(32).toString('hex');
  await createSession(token, newUser.username);
  res.cookie('sid', token, SESSION_COOKIE);
  res.json({ username: newUser.username });
});

app.post('/api/auth/verify-pin', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { pin } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('username', username).single();
  if (!user || user.pin_hash !== hashPin(username, pin)) return res.status(401).json({ error: 'Incorrect PIN' });
  res.json({ ok: true });
});

app.post('/api/auth/change-pin', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { currentPin, newPin } = req.body;
  if (!/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'New PIN must be 4 digits' });
  const { data: user } = await supabase.from('users').select('*').eq('username', username).single();
  if (!user || user.pin_hash !== hashPin(username, currentPin)) return res.status(401).json({ error: 'Incorrect current PIN' });
  await supabase.from('users').update({ pin_hash: hashPin(username, newPin) }).eq('username', username);
  res.json({ ok: true });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = parseCookies(req).sid;
  if (token) await deleteSession(token);
  res.clearCookie('sid');
  res.json({ ok: true });
});

// ── User API key management ───────────────────────────────────────────────────

app.get('/api/user/keys', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const keys = await getUserKeys(username);
  res.json({
    anthropic_key: keys.anthropic_key ? keys.anthropic_key.slice(0, 10) + '…' : '',
    openai_key:    keys.openai_key    ? keys.openai_key.slice(0, 10)    + '…' : '',
    anthropic_set: !!keys.anthropic_key,
    openai_set:    !!keys.openai_key,
  });
});

app.post('/api/user/keys', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { anthropic_key, openai_key } = req.body || {};
  const update = {};
  if (typeof anthropic_key === 'string') update.anthropic_key = anthropic_key.trim() || null;
  if (typeof openai_key    === 'string') update.openai_key    = openai_key.trim()    || null;
  if (!Object.keys(update).length) return res.status(400).json({ error: 'No keys provided' });
  const { error } = await supabase.from('users').update(update).eq('username', username);
  if (error) return res.status(500).json({ error: error.message });
  userKeysCache.delete(username);
  res.json({ ok: true });
});

// ── Data endpoints ────────────────────────────────────────────────────────────

app.get('/api/courses', async (req, res) => {
  const all = await loadAllCourses();
  const courses = {};
  for (const [id, data] of Object.entries(all)) {
    const { questions, ...courseData } = data;
    courses[id] = courseData;
  }
  res.json({ courses });
});

app.get('/api/questions', async (req, res) => {
  const all = await loadAllCourses();
  const questions = {};
  for (const [id, data] of Object.entries(all)) {
    questions[id] = data.questions || [];
  }
  res.json(questions);
});

// ── Slide deck upload ─────────────────────────────────────────────────────────
// POST /api/courses/:courseId/slides  (multipart/form-data)
//   fields: file (PDF, required), title (optional — defaults to filename stem),
//           session_ext_id (optional — attaches to a specific session)
app.post('/api/courses/:courseId/slides', uploadPdf.single('file'), async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { courseId } = req.params;
  if (!COURSE_IDS.includes(courseId)) return res.status(404).json({ error: 'Unknown course' });

  const file = req.file;
  if (!file) return res.status(400).json({ error: 'PDF file required' });

  const rawTitle = (req.body.title || path.parse(file.originalname).name).trim();
  let sessionExtId = (req.body.session_ext_id || '').trim() || null;
  const newSessionTitle = (req.body.new_session_title || '').trim();

  if (newSessionTitle) {
    // Create a new session row and use its ext_id
    const { data: existingSessions } = await supabase
      .from('course_sessions').select('ext_id, order_idx').eq('course_id', courseId).order('order_idx', { ascending: false }).limit(1);
    const lastSession = existingSessions?.[0];
    const nextOrderIdx = lastSession ? lastSession.order_idx + 1 : 1;
    const numericNext = parseInt(lastSession?.ext_id, 10);
    const newExtId = (!isNaN(numericNext) ? (numericNext + 1) : nextOrderIdx).toString();
    const { error: sessErr } = await supabase.from('course_sessions').insert({
      course_id: courseId,
      ext_id: newExtId,
      title: newSessionTitle,
      topics: [],
      order_idx: nextOrderIdx,
    });
    if (sessErr) return res.status(500).json({ error: 'Could not create session: ' + sessErr.message });
    sessionExtId = newExtId;
  } else if (sessionExtId) {
    // Validate session_ext_id if provided
    const course = await loadCourse(courseId);
    if (!course || !course.sessions.find(s => s.id === sessionExtId)) {
      return res.status(400).json({ error: 'Unknown session for this course' });
    }
  }

  const slug = rawTitle.toLowerCase()
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'slides';
  const storagePath = `${courseId}/${slug}-${Date.now()}.pdf`;

  const { error: upErr } = await supabase.storage
    .from('course-slides')
    .upload(storagePath, file.buffer, { contentType: 'application/pdf', upsert: false });
  if (upErr) return res.status(500).json({ error: 'Upload failed: ' + upErr.message });

  const publicUrl = supabase.storage.from('course-slides').getPublicUrl(storagePath).data.publicUrl;

  // order_idx: place after all migrated slides for the same session
  const { data: existing } = await supabase.from('course_slides')
    .select('order_idx').eq('course_id', courseId).eq('session_ext_id', sessionExtId)
    .order('order_idx', { ascending: false }).limit(1);
  const nextIdx = (existing && existing[0] ? existing[0].order_idx : 0) + 1;

  const { data: inserted, error: insErr } = await supabase.from('course_slides').insert({
    course_id: courseId,
    session_ext_id: sessionExtId,
    title: rawTitle,
    storage_path: storagePath,
    public_url: publicUrl,
    file_size_kb: Math.round(file.size / 1024),
    source: 'uploaded',
    order_idx: nextIdx
  }).select().single();
  if (insErr) {
    // best-effort cleanup of orphaned Storage object
    await supabase.storage.from('course-slides').remove([storagePath]);
    return res.status(500).json({ error: 'DB insert failed: ' + insErr.message });
  }

  invalidateCourses();
  res.json({ slide: { title: rawTitle, file: publicUrl, id: inserted.id, session_ext_id: sessionExtId } });
});

// Multer error handler — turns oversized/non-PDF rejections into JSON responses
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'PDF too large (max 45 MB)' });
  if (err && err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  next(err);
});

app.get('/api/progress', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const userId = await getUserId(username);
  if (!userId) return res.json({});
  res.json(await getProgressFromDB(userId));
});

app.post('/api/progress', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const userId = await getUserId(username);
  if (!userId) return res.status(404).json({ error: 'User not found' });
  await saveProgressToDB(userId, req.body);
  res.json({ ok: true });
});

// ── Study Orbit planner ──────────────────────────────────────────────────────

app.get('/api/study-orbit', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    res.json(await getStudyOrbitPayload(userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/study/preferences', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    const existing = await ensureStudyPreferences(userId);
    const prefs = normalizeStudyPrefs(req.body || {}, existing);
    const extra = {};
    if (req.body?.markSetupComplete === true) extra.setup_complete = true;
    await supabase.from('study_preferences').upsert({
      user_id: userId,
      ...prefs,
      ...extra,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    await regenerateStudyPlan(userId, { fromDate: dateKey() });
    res.json(await getStudyOrbitPayload(userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/study/setup-complete', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    await supabase.from('study_preferences').update({ setup_complete: true, updated_at: new Date().toISOString() }).eq('user_id', userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/study/ratings', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    const rows = Array.isArray(req.body?.ratings) ? req.body.ratings : [];
    const upserts = rows
      .filter(r => r.courseId)
      .map(r => ({
        user_id: userId,
        course_id: r.courseId,
        session_id: r.sessionId || '__course__',
        slide_load: normalizeRating(r.slideLoad),
        lecture_depth: normalizeRating(r.lectureDepth),
        required_depth: normalizeRating(r.requiredDepth),
        syllabus_difficulty: normalizeRating(r.syllabusDifficulty),
        effort: normalizeRating(r.effort),
        updated_at: new Date().toISOString()
      }));
    if (upserts.length) {
      await supabase.from('study_course_ratings').upsert(upserts, { onConflict: 'user_id,course_id,session_id' });
    }
    await regenerateStudyPlan(userId, { fromDate: dateKey() });
    res.json(await getStudyOrbitPayload(userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/study/plan/regenerate', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    await regenerateStudyPlan(userId, { fromDate: req.body?.fromDate || dateKey() });
    res.json(await getStudyOrbitPayload(userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/study/plan/replan-future', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    res.json(await getStudyOrbitPayload(userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/study/tasks/:id', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    const status = ['pending', 'completed', 'skipped'].includes(req.body?.status) ? req.body.status : 'pending';
    await supabase.from('study_plan_tasks').update({
      status,
      completed_at: status === 'completed' ? new Date().toISOString() : null
    }).eq('id', req.params.id).eq('user_id', userId);
    res.json({ ok: true, taskId: req.params.id, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/study/tasks/:id', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    await supabase.from('study_plan_tasks').delete().eq('id', req.params.id).eq('user_id', userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/study/tasks/add-today', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    const result = await executeOrbitTool(userId, 'add_tasks_today', {});
    res.json(await getStudyOrbitPayload(userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/study/tasks/:id/move', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    const targetDate = req.body?.targetDate || addDaysKey(dateKey(), 1);
    const prefs = await ensureStudyPreferences(userId);
    const overrides = prefs.daily_overrides || {};
    const dayOverride = overrides[targetDate] || {};
    const wake = dayOverride.wakeTime || dayOverride.wake_time || prefs.wake_time || '08:30';
    const bed = dayOverride.bedTime || dayOverride.bed_time || prefs.bed_time || '23:30';

    const { data: existingTask } = await supabase
      .from('study_plan_tasks')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .maybeSingle();
    if (!existingTask) return res.status(404).json({ error: 'Task not found' });

    const { data: day, error: dayErr } = await supabase
      .from('study_plan_days')
      .upsert({
        user_id: userId,
        plan_date: targetDate,
        wake_time: wake,
        bed_time: bed,
        effort_level: prefs.daily_effort,
        summary: {},
        generated_at: new Date().toISOString()
      }, { onConflict: 'user_id,plan_date' })
      .select()
      .single();
    if (dayErr) throw dayErr;

    const { data: dayTasks } = await supabase
      .from('study_plan_tasks')
      .select('end_time')
      .eq('day_id', day.id)
      .neq('id', req.params.id)
      .order('end_time', { ascending: false })
      .limit(1);

    const fixedBreaks = normalizeBreakBlocks(prefs, dayOverride);
    const wakeMin = parseTimeMinutes(wake, '08:30');
    const bedMin = parseTimeMinutes(bed, '23:30');
    const lastEnd = dayTasks?.[0]?.end_time ? parseTimeMinutes(dayTasks[0].end_time, wake) + 10 : wakeMin + 20;
    let start = pushThroughFixedBreaks(Math.max(wakeMin + 20, lastEnd), existingTask.duration_minutes || 25, fixedBreaks);
    if (start + (existingTask.duration_minutes || 25) > bedMin) start = wakeMin + 20;
    const end = start + (existingTask.duration_minutes || 25);

    await supabase.from('study_plan_tasks').update({
      day_id: day.id,
      start_time: formatTimeMinutes(start),
      end_time: formatTimeMinutes(end),
      status: 'pending',
      completed_at: null
    }).eq('id', req.params.id).eq('user_id', userId);

    // Replan future days but:
    //  - protect the moved task so the delete phase doesn't wipe it off the target day
    //  - exclude its generated_key from the backlog so it isn't double-scheduled
    await regenerateStudyPlan(userId, {
      fromDate: addDaysKey(dateKey(), 1),
      protectedTaskIds: [req.params.id],
      extraExcludeKeys: existingTask.generated_key ? new Set([existingTask.generated_key]) : new Set(),
    });
    res.json(await getStudyOrbitPayload(userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Quiz answer logging (drives adaptive learning) ────────────────────────────

app.post('/api/quiz-answer', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { questionId, courseId, sessionId, selectedAnswer, isCorrect } = req.body;
  if (!questionId || !courseId || isCorrect === undefined) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const userId = await getUserId(username);
  if (!userId) return res.status(404).json({ error: 'User not found' });

  await supabase.from('quiz_answers').insert({
    user_id: userId,
    question_id: questionId,
    course_id: courseId,
    session_id: sessionId || 'unknown',
    selected_answer: selectedAnswer || null,
    is_correct: isCorrect
  });
  res.json({ ok: true });
});

// ── Adaptive questions ────────────────────────────────────────────────────────

app.get('/api/adaptive-questions', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { courseId, count = 10 } = req.query;
  if (!courseId) return res.status(400).json({ error: 'courseId required' });

  const userId = await getUserId(username);
  const course = await loadCourse(courseId);
  const allQs = (course && course.questions) || [];
  const n = Math.min(parseInt(count), allQs.length);

  if (!userId) return res.json(shuffle(allQs).slice(0, n));

  // Get answer history for this course
  const { data: answers } = await supabase
    .from('quiz_answers')
    .select('question_id, is_correct, answered_at')
    .eq('user_id', userId)
    .eq('course_id', courseId)
    .order('answered_at', { ascending: false });

  // Build per-question accuracy stats
  const stats = {};
  for (const a of answers || []) {
    if (!stats[a.question_id]) stats[a.question_id] = { total: 0, correct: 0, lastSeen: null };
    stats[a.question_id].total++;
    if (a.is_correct) stats[a.question_id].correct++;
    if (!stats[a.question_id].lastSeen) stats[a.question_id].lastSeen = a.answered_at;
  }

  // Score each question (higher priority = show more)
  const scored = allQs.map(q => {
    const s = stats[q.id];
    let priority;
    if (!s || s.total === 0) {
      priority = 0.5; // unseen — medium priority
    } else {
      const accuracy = s.correct / s.total;
      const daysSince = s.lastSeen ? (Date.now() - new Date(s.lastSeen)) / 86400000 : 30;
      const recencyBoost = accuracy < 0.6 ? Math.max(0, 1 - daysSince / 7) * 0.3 : 0;
      priority = (1 - accuracy) + recencyBoost;
    }
    return { q, priority, hasHistory: !!s };
  });

  const weak   = scored.filter(x => x.hasHistory && x.priority > 0.4).sort((a, b) => b.priority - a.priority);
  const unseen = scored.filter(x => !x.hasHistory);
  const strong = scored.filter(x => x.hasHistory && x.priority <= 0.4);

  const weakCount   = Math.floor(n * 0.6);
  const unseenCount = Math.floor(n * 0.25);
  const strongCount = n - weakCount - unseenCount;

  const selected = [
    ...shuffle(weak.map(x => x.q)).slice(0, weakCount),
    ...shuffle(unseen.map(x => x.q)).slice(0, unseenCount),
    ...shuffle(strong.map(x => x.q)).slice(0, strongCount)
  ];

  // Fill any shortfall (e.g. not enough weak questions yet)
  if (selected.length < n) {
    const have = new Set(selected.map(q => q.id));
    const rest = allQs.filter(q => !have.has(q.id));
    selected.push(...shuffle(rest).slice(0, n - selected.length));
  }

  res.json(shuffle(selected).slice(0, n));
});

// ── Study session tracking ────────────────────────────────────────────────────

app.post('/api/session/start', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const userId = await getUserId(username);
  if (!userId) return res.status(404).json({ error: 'User not found' });

  const { data: session } = await supabase
    .from('study_sessions')
    .insert({ user_id: userId })
    .select()
    .single();

  res.json({ sessionId: session.id });
});

app.post('/api/session/ping', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { sessionId, courseId, isCorrect } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const update = {
    questions_answered: supabase.rpc('questions_answered'), // incremented below
    updated: new Date().toISOString()
  };

  // Use raw SQL increment via RPC isn't available without custom function, so fetch+update
  const { data: existing } = await supabase
    .from('study_sessions')
    .select('questions_answered, correct_answers, courses_touched')
    .eq('id', sessionId)
    .single();

  if (!existing) return res.status(404).json({ error: 'Session not found' });

  const touched = existing.courses_touched || [];
  if (courseId && !touched.includes(courseId)) touched.push(courseId);

  await supabase.from('study_sessions').update({
    questions_answered: (existing.questions_answered || 0) + 1,
    correct_answers: (existing.correct_answers || 0) + (isCorrect ? 1 : 0),
    courses_touched: touched
  }).eq('id', sessionId);

  res.json({ ok: true });
});

app.get('/api/session/summary/:sessionId', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { sessionId } = req.params;

  const { data: session } = await supabase
    .from('study_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (!session) return res.status(404).json({ error: 'Session not found' });

  const userId = await getUserId(username);
  const totalAnswered = session.questions_answered || 0;
  const totalCorrect  = session.correct_answers || 0;
  const accuracy      = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;

  // Find weakest topic in this session
  let weakestTopic = null;
  if (userId && session.courses_touched?.length > 0) {
    const courseId = session.courses_touched[0];
    const { data: recentAnswers } = await supabase
      .from('quiz_answers')
      .select('session_id, is_correct')
      .eq('user_id', userId)
      .eq('course_id', courseId)
      .gte('answered_at', session.started_at);

    if (recentAnswers?.length > 0) {
      const bySession = {};
      for (const a of recentAnswers) {
        if (!bySession[a.session_id]) bySession[a.session_id] = { correct: 0, total: 0 };
        bySession[a.session_id].total++;
        if (a.is_correct) bySession[a.session_id].correct++;
      }
      const worst = Object.entries(bySession)
        .map(([sid, s]) => ({ sid, acc: s.correct / s.total }))
        .sort((a, b) => a.acc - b.acc)[0];
      if (worst) {
        const course = await loadCourse(courseId);
        const sess = course && course.sessions.find(s => s.id === worst.sid);
        weakestTopic = sess ? sess.title : worst.sid;
      }
    }
  }

  res.json({ totalAnswered, accuracy, weakestTopic, coursesTouched: session.courses_touched || [] });
});

app.post('/api/session/end', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  await supabase.from('study_sessions').update({ ended_at: new Date().toISOString() }).eq('id', sessionId);
  res.json({ ok: true });
});

// ── Chat conversation persistence ─────────────────────────────────────────────

app.get('/api/conversations', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const userId = await getUserId(username);
  if (!userId) return res.json({ conversations: {} });

  const { data: rows } = await supabase
    .from('chat_conversations')
    .select('id, course_id, title, messages, is_draft, mode, summary, summarized_up_to, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  // Reshape to { courseId: [conv, ...] } format matching localStorage structure
  const conversations = {};
  for (const row of rows || []) {
    if (!conversations[row.course_id]) conversations[row.course_id] = [];
    conversations[row.course_id].push({
      id: row.id,
      title: row.title,
      messages: row.messages,
      draft: row.is_draft,
      mode: row.mode || 'text',
      summary: row.summary || '',
      summarizedUpTo: row.summarized_up_to || 0,
      created: new Date(row.created_at).getTime(),
      updated: new Date(row.updated_at).getTime()
    });
  }
  res.json({ conversations });
});

// Bulk sync: client sends its full chat data, server upserts everything
app.post('/api/conversations/sync', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const userId = await getUserId(username);
  if (!userId) return res.status(404).json({ error: 'User not found' });

  const { conversations } = req.body;
  if (!conversations) return res.status(400).json({ error: 'conversations required' });

  const rows = [];
  for (const [courseId, convList] of Object.entries(conversations)) {
    for (const conv of convList) {
      if (!conv.id || !Array.isArray(conv.messages)) continue;
      rows.push({
        id: conv.id,
        user_id: userId,
        course_id: courseId,
        title: conv.title || 'Conversation',
        messages: conv.messages,
        is_draft: conv.draft || false,
        mode: conv.mode || 'text',
        summary: conv.summary || null,
        summarized_up_to: Number.isFinite(conv.summarizedUpTo) ? conv.summarizedUpTo : 0,
        updated_at: new Date(conv.updated || Date.now()).toISOString()
      });
    }
  }

  if (rows.length > 0) {
    await supabase.from('chat_conversations')
      .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });
  }
  res.json({ ok: true, synced: rows.length });
});

app.delete('/api/conversations/:id', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const userId = await getUserId(username);
  await supabase.from('chat_conversations').delete().eq('id', req.params.id).eq('user_id', userId);
  res.json({ ok: true });
});

// ── File upload to Supabase Storage ──────────────────────────────────────────

app.post('/api/upload', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });

  const { name, mediaType, data: base64Data } = req.body;
  if (!name || !mediaType || !base64Data) {
    return res.status(400).json({ error: 'name, mediaType, and data required' });
  }

  const buffer = Buffer.from(base64Data, 'base64');
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `${username}/${Date.now()}-${safeName}`;

  const { data: uploadData, error } = await supabase.storage
    .from('study-files')
    .upload(filePath, buffer, { contentType: mediaType, upsert: false });

  if (error) return res.status(500).json({ error: error.message });

  const { data: { publicUrl } } = supabase.storage.from('study-files').getPublicUrl(uploadData.path);
  res.json({ url: publicUrl, path: uploadData.path });
});

// ── Study Orbit agent chat ────────────────────────────────────────────────────

async function getOrbitAgentMemory(userId) {
  const { data } = await supabase
    .from('study_agent_memory')
    .select('facts, summary')
    .eq('user_id', userId)
    .maybeSingle();
  return data || { facts: {}, summary: '' };
}

async function getOrbitConversation(userId) {
  const { data } = await supabase
    .from('chat_conversations')
    .select('id, messages, summary, summarized_up_to')
    .eq('user_id', userId)
    .eq('course_id', '__orbit_agent__')
    .maybeSingle();
  return data || null;
}

async function saveOrbitConversation(userId, conv, newMessages, anthropicKey) {
  const all = [...(conv?.messages || []), ...newMessages];
  let summary = conv?.summary || '';
  let summarizedUpTo = conv?.summarized_up_to || 0;
  // Compress oldest messages when history exceeds 40 turns
  if (all.length > 40) {
    const toCompress = all.slice(0, 20);
    summarizedUpTo += toCompress.length;
    const compressPrompt = `Summarise the following study agent conversation in 3–5 sentences, focusing on any decisions made, patterns observed, or schedule changes agreed. Be factual and brief.\n\n${toCompress.map(m => `${m.role}: ${m.content}`).join('\n')}`;
    try {
      const apiKey = anthropicKey;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: compressPrompt }] })
      });
      const d = await r.json();
      summary = (summary ? summary + '\n\n' : '') + (d.content?.[0]?.text || '');
    } catch (_) { /* compression failure is non-fatal */ }
    all.splice(0, 20);
  }
  const row = {
    user_id: userId,
    course_id: '__orbit_agent__',
    title: 'Study Orbit Agent',
    messages: all,
    is_draft: false,
    mode: 'text',
    summary,
    summarized_up_to: summarizedUpTo,
    updated_at: new Date().toISOString()
  };
  if (conv?.id) {
    await supabase.from('chat_conversations').update(row).eq('id', conv.id);
  } else {
    row.id = `orbit-agent-${userId}`;
    await supabase.from('chat_conversations').upsert(row, { onConflict: 'id' });
  }
}

function buildOrbitSystemPrompt(snapshot, memory, convSummary) {
  const prefs = snapshot?.preferences || {};
  const today = snapshot?.today || new Date().toISOString().slice(0, 10);
  const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const examLines = Object.entries(COURSE_EXAM_DATES)
    .map(([cid, d]) => `  - ${cid}: ${d}`)
    .join('\n');

  const taskLines = (snapshot?.days || [])
    .slice(0, 7)
    .flatMap(day =>
      (day.tasks || [])
        .filter(t => t.tool !== 'break' && t.taskType !== 'break')
        .map(t => `  [${t.id}] ${day.date} ${t.startTime}-${t.endTime} ${t.courseId} | ${t.title} | ${t.status}`)
    )
    .join('\n');

  const memorySection = memory.summary
    ? `\nWhat I know about Ricky so far:\n${memory.summary}\n`
    : '';
  const factsSection = Object.keys(memory.facts || {}).length
    ? `\nObserved patterns:\n${Object.entries(memory.facts).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}\n`
    : '';
  const historySection = convSummary
    ? `\nPast conversation summary:\n${convSummary}\n`
    : '';

  return `You are Orbit, Ricky's personal study-schedule agent. Today is ${today}, current time ${now}.

Your job is to understand Ricky's situation, update his study plan directly using your tools, and learn patterns about how he works so you can serve him better over time.

Exam dates:
${examLines}

Ricky's current preferences:
  - Wake: ${prefs.wakeTime || '08:30'}, Bed: ${prefs.bedTime || '23:30'}
  - Daily effort: ${prefs.dailyEffort || 'medium'}
${memorySection}${factsSection}${historySection}
Upcoming tasks (next 14 days):
${taskLines || '  (none scheduled)'}

Available tools:
- update_task_status: mark a specific task complete, skipped, or pending (requires task ID)
- move_task: reschedule a task to a different date (and optionally start time)
- update_preferences: change wake/bed times, effort level, or set a daily override (studyMinutes, skipCourses, breaks)
- update_course_rating: adjust a difficulty rating for a course (slide_load, lecture_depth, required_depth, syllabus_difficulty, effort — each low/medium/high)
- update_exam_date: override the exam date/time for a course when the user says it has moved
- trigger_replan: regenerate the full study plan from a given date
- store_observation: persist a pattern or preference you've observed about Ricky
- mark_work_done: mark all pending tasks for a course as completed (filter by task_type, tool, or session_id) — use when user says they already did work outside the app
- replace_today: mark a specific session done AND immediately fill today's freed time with a replacement task — use when user says "I finished X, give me something else"
- add_tasks_today: fill today (and future days) with new tasks from the backlog WITHOUT marking anything done — use when user says "add tasks", "give me more work", "fill my day", "what can I study", or any request to schedule new work without having completed something specific

Guidelines:
- Be concise and direct. One short paragraph max per reply.
- For "add tasks / give me work / fill my day / what can I do today / schedule something for me": call add_tasks_today. Do NOT ask what they've done first — just add tasks.
- For "I finished/attended lecture X / I already did X, give me something to do": call replace_today with course_id and session_id. Do NOT set fill_mode unless intent is explicit — the UI will show a dropdown. If intent IS clear: "give me a quiz / review / consolidate" → fill_mode=consolidate (marks only first_pass done, inserts review tasks); "next lecture / continue in X" → fill_mode=progress (marks all stages done, inserts next X lecture); "something different / switch / different subject" → fill_mode=switch (marks all stages done, inserts different course). Key: progress and switch mark the full lecture done and move on — consolidate keeps review tasks in the schedule.
- For "I fully studied X — notes, understanding, AND quiz": call replace_today with all_stages=true. This marks everything done and fills today with work from other courses.
- For "I already studied X" (just logging, not asking for replacement): call mark_work_done with course_id AND session_id, then trigger_replan.
- For "skip/avoid/don't want course X today": call update_preferences with dailyOverride.skipCourses=["course_id"] for today's date, then trigger_replan. Do NOT use move_task for this.
- For "I'm busy/out HH:MM–HH:MM on date X": call update_preferences with dailyOverride.breaks=[{start,end,label}] for that date, then trigger_replan.
- For "my exam moved to X": call update_exam_date, then trigger_replan.
- CRITICAL for mark_work_done: always pass session_id when the user mentions a specific lecture/session. Without session_id it marks the ENTIRE course across all future days — only do that if Ricky explicitly says they're done with the whole course.
- For "what should I do right now?": look at the current time (${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}), find the pending task on today's plan closest to now, recommend it with one line of reasoning. No tools needed.
- For "why is X scheduled?" or "explain my plan": use the reasoning field from the task list above to explain directly. No tools needed.
- When Ricky mentions a course feels harder or easier than rated, call update_course_rating, then trigger_replan.
- When you notice a durable pattern (sleep sensitivity, time preferences, etc.) call store_observation.
- ALWAYS call trigger_replan after any tool that changes what tasks exist or which courses are skipped (mark_work_done, update_preferences with skipCourses/breaks/studyMinutes, update_exam_date, update_course_rating). Do not skip this step.
- After any schedule change, tell Ricky what you did in plain language.
- Do not ask clarifying questions unless the request is genuinely ambiguous.`;
}

const ORBIT_TOOLS = [
  {
    name: 'update_task_status',
    description: 'Mark a task as completed, skipped, or pending.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task UUID' },
        status: { type: 'string', enum: ['completed', 'skipped', 'pending'] }
      },
      required: ['task_id', 'status']
    }
  },
  {
    name: 'move_task',
    description: 'Move a task to a different date (and optionally a start time).',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task UUID' },
        new_date: { type: 'string', description: 'YYYY-MM-DD target date' },
        start_time: { type: 'string', description: 'HH:MM start time (optional)' }
      },
      required: ['task_id', 'new_date']
    }
  },
  {
    name: 'update_preferences',
    description: 'Update global preferences (wake/bed time, effort) or set a day-level override.',
    input_schema: {
      type: 'object',
      properties: {
        wakeTime: { type: 'string', description: 'HH:MM global wake time' },
        bedTime: { type: 'string', description: 'HH:MM global bed time' },
        dailyEffort: { type: 'string', enum: ['low', 'medium', 'high'] },
        dailyOverride: {
          type: 'object',
          description: 'Override for a specific date',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            wakeTime: { type: 'string' },
            bedTime: { type: 'string' },
            studyMinutes: { type: 'number', description: 'Max study minutes for the day' },
            skipCourses: { type: 'array', items: { type: 'string' }, description: 'Course IDs to exclude from the plan on this date (e.g. ["ibm"])' },
            breaks: { type: 'array', items: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' }, label: { type: 'string' } }, required: ['start', 'end'] }, description: 'Time blocks to mark unavailable, e.g. [{start:"18:00",end:"21:00",label:"Out"}]' }
          },
          required: ['date']
        }
      }
    }
  },
  {
    name: 'update_course_rating',
    description: 'Adjust a difficulty dimension for a course.',
    input_schema: {
      type: 'object',
      properties: {
        course_id: { type: 'string', enum: ['gtm', 'geopolitics', 'digital_strategy', 'ibm', 'ism'] },
        field: { type: 'string', enum: ['slide_load', 'lecture_depth', 'required_depth', 'syllabus_difficulty', 'effort'] },
        value: { type: 'string', enum: ['low', 'medium', 'high'] }
      },
      required: ['course_id', 'field', 'value']
    }
  },
  {
    name: 'trigger_replan',
    description: 'Regenerate the study plan from a given date (defaults to today).',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' }
      }
    }
  },
  {
    name: 'store_observation',
    description: 'Persist a learned pattern or preference about Ricky into long-term memory.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short camel-case key, e.g. sleepSensitivity' },
        observation: { type: 'string', description: 'One-sentence prose description of the pattern' }
      },
      required: ['key', 'observation']
    }
  },
  {
    name: 'update_exam_date',
    description: 'Override the exam date (and optionally start time) for a course. Use when the user says their exam has moved.',
    input_schema: {
      type: 'object',
      properties: {
        course_id: { type: 'string', enum: ['gtm', 'geopolitics', 'digital_strategy', 'ibm', 'ism'] },
        new_date: { type: 'string', description: 'YYYY-MM-DD new exam date' },
        new_time: { type: 'string', description: 'HH:MM exam start time (optional)' }
      },
      required: ['course_id', 'new_date']
    }
  },
  {
    name: 'mark_work_done',
    description: 'Mark pending tasks for a course as completed when the user has already done that work outside the app. IMPORTANT: without session_id this marks ALL pending tasks for the course across every future day — only omit it if the user explicitly says they are done with the whole course. Always pass session_id when the user refers to a specific lecture. Optionally filter by task type (first_pass, knowledge_update, deep_work, retrieval, spaced_review) or tool (notes, quiz, agent, canvas).',
    input_schema: {
      type: 'object',
      properties: {
        course_id: { type: 'string', enum: ['gtm', 'geopolitics', 'digital_strategy', 'ibm', 'ism'] },
        session_id: { type: 'string', description: 'Strongly recommended: only mark tasks for this specific lecture session (e.g. "1", "2"). Omit only when marking the whole course done.' },
        task_type: { type: 'string', description: 'Optional: only mark tasks of this type (e.g. first_pass for notes, retrieval for quizzes)' },
        tool: { type: 'string', description: 'Optional: only mark tasks using this tool (notes, quiz, agent, canvas)' }
      },
      required: ['course_id']
    }
  },
  {
    name: 'replace_today',
    description: 'Mark a lecture session as done and reschedule today with replacement tasks, then replan future days. By default only marks the first_pass (initial reading/notes) as done. Set all_stages=true only if the user explicitly says they fully studied the session including notes, understanding, and quiz practice. Use fill_mode to steer what kind of replacement is scheduled (the UI will ask if omitted).',
    input_schema: {
      type: 'object',
      properties: {
        course_id: { type: 'string', enum: ['gtm', 'geopolitics', 'digital_strategy', 'ibm', 'ism'], description: 'Course whose session was completed' },
        session_id: { type: 'string', description: 'The specific lecture/session number that was completed (e.g. "1", "2"). Always provide this.' },
        all_stages: { type: 'boolean', description: 'Set true only if the user says they FULLY studied the session (notes, consolidation, AND quiz). Defaults to false — only marks first_pass done.' },
        fill_mode: { type: 'string', enum: ['consolidate', 'progress', 'switch'], description: 'consolidate: fill today only with remaining stages of this same session (knowledge_update, retrieval, spaced_review). progress: fill with next unfinished work in the same course (any session or stage). switch: fill with highest-priority work from a different course. Omit to let the UI ask Ricky — only set this if intent is clear from the message.' }
      },
      required: ['course_id', 'session_id']
    }
  },
  {
    name: 'add_tasks_today',
    description: 'Rebuild today\'s plan (and future days) to fill available time with tasks from the backlog, WITHOUT marking anything as done. Use this when the user asks to add tasks, get more work, fill their day, or schedule something new — any request to get new tasks without having finished a specific session. Returns the tasks now on today\'s schedule.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Brief description of why tasks are being added, e.g. "user has free time" or "user wants more work today"' }
      }
    }
  }
];

async function executeOrbitTool(userId, toolName, input) {
  switch (toolName) {
    case 'update_task_status': {
      const status = ['pending', 'completed', 'skipped'].includes(input.status) ? input.status : 'pending';
      await supabase.from('study_plan_tasks').update({
        status,
        completed_at: status === 'completed' ? new Date().toISOString() : null
      }).eq('id', input.task_id).eq('user_id', userId);
      return { ok: true };
    }
    case 'move_task': {
      const prefs = await ensureStudyPreferences(userId);
      const overrides = prefs.daily_overrides || {};
      const targetDate = input.new_date;
      const dayOverride = overrides[targetDate] || {};
      const wake = dayOverride.wakeTime || prefs.wake_time || '08:30';
      const bed = dayOverride.bedTime || prefs.bed_time || '23:30';
      const { data: existingTask } = await supabase.from('study_plan_tasks').select('*').eq('id', input.task_id).eq('user_id', userId).maybeSingle();
      if (!existingTask) return { error: 'Task not found' };
      const { data: day, error: dayErr } = await supabase.from('study_plan_days').upsert({
        user_id: userId, plan_date: targetDate, wake_time: wake, bed_time: bed,
        effort_level: prefs.daily_effort, summary: {}, generated_at: new Date().toISOString()
      }, { onConflict: 'user_id,plan_date' }).select().single();
      if (dayErr) return { error: dayErr.message };
      let startMin;
      if (input.start_time && /^\d{1,2}:\d{2}$/.test(input.start_time)) {
        startMin = parseTimeMinutes(input.start_time, wake);
      } else {
        const { data: dayTasks } = await supabase.from('study_plan_tasks').select('end_time').eq('day_id', day.id).neq('id', input.task_id).order('end_time', { ascending: false }).limit(1);
        const wakeMin = parseTimeMinutes(wake, '08:30');
        const lastEnd = dayTasks?.[0]?.end_time ? parseTimeMinutes(dayTasks[0].end_time, wake) + 10 : wakeMin + 20;
        const fixedBreaks = normalizeBreakBlocks(prefs, dayOverride);
        startMin = pushThroughFixedBreaks(Math.max(wakeMin + 20, lastEnd), existingTask.duration_minutes || 25, fixedBreaks);
      }
      const endMin = startMin + (existingTask.duration_minutes || 25);
      await supabase.from('study_plan_tasks').update({
        day_id: day.id, start_time: formatTimeMinutes(startMin), end_time: formatTimeMinutes(endMin), status: 'pending', completed_at: null
      }).eq('id', input.task_id).eq('user_id', userId);
      return { ok: true };
    }
    case 'update_preferences': {
      const existing = await ensureStudyPreferences(userId);
      let patch = {};
      if (input.wakeTime) patch.wakeTime = input.wakeTime;
      if (input.bedTime) patch.bedTime = input.bedTime;
      if (input.dailyEffort) patch.dailyEffort = input.dailyEffort;
      if (input.dailyOverride) {
        const current = existing.daily_overrides || {};
        const { date, breaks: newBreaks, skipCourses: newSkip, ...rest } = input.dailyOverride;
        const existingDay = current[date] || {};
        // Deep-merge arrays instead of overwriting
        const mergedBreaks = newBreaks ? [...(existingDay.breaks || []), ...newBreaks] : existingDay.breaks;
        const mergedSkip = newSkip ? [...new Set([...(existingDay.skipCourses || []), ...newSkip])] : existingDay.skipCourses;
        patch.dailyOverrides = {
          ...current,
          [date]: {
            ...existingDay,
            ...rest,
            ...(mergedBreaks !== undefined ? { breaks: mergedBreaks } : {}),
            ...(mergedSkip !== undefined ? { skipCourses: mergedSkip } : {})
          }
        };
      }
      const prefs = normalizeStudyPrefs(patch, existing);
      const { error: upsertErr } = await supabase.from('study_preferences').upsert({ user_id: userId, ...prefs, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (upsertErr) { console.error('[orbit-tool] update_preferences upsert error:', upsertErr.message); return { error: upsertErr.message }; }
      return { ok: true };
    }
    case 'update_course_rating': {
      const { course_id, field, value } = input;
      if (!COURSE_IDS.includes(course_id)) return { error: 'Unknown course' };
      const ratingFields = ['slide_load', 'lecture_depth', 'required_depth', 'syllabus_difficulty', 'effort'];
      if (!ratingFields.includes(field)) return { error: 'Unknown field' };
      const normalized = normalizeRating(value);
      await supabase.from('study_course_ratings').upsert({
        user_id: userId, course_id, session_id: '__course__',
        [field]: normalized, updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,course_id,session_id' });
      return { ok: true };
    }
    case 'trigger_replan': {
      const fromDate = input.from_date || dateKey();
      await regenerateStudyPlan(userId, { fromDate });
      return { ok: true };
    }
    case 'store_observation': {
      const { data: mem } = await supabase.from('study_agent_memory').select('facts').eq('user_id', userId).maybeSingle();
      const facts = { ...(mem?.facts || {}), [input.key]: input.observation };
      await supabase.from('study_agent_memory').upsert({ user_id: userId, facts, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      return { ok: true };
    }
    case 'update_exam_date': {
      const existing = await ensureStudyPreferences(userId);
      const current = existing.exam_overrides || {};
      const override = { ...(current[input.course_id] || {}), date: input.new_date };
      if (input.new_time) override.time = input.new_time;
      await supabase.from('study_preferences').upsert({
        user_id: userId,
        exam_overrides: { ...current, [input.course_id]: override },
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
      return { ok: true };
    }
    case 'mark_work_done': {
      if (!COURSE_IDS.includes(input.course_id)) return { error: 'Unknown course' };
      let query = supabase.from('study_plan_tasks')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('course_id', input.course_id)
        .eq('status', 'pending');
      if (input.session_id) query = query.eq('session_id', input.session_id);
      if (input.task_type) query = query.eq('task_type', input.task_type);
      if (input.tool) query = query.eq('tool', input.tool);
      await query;
      return { ok: true };
    }
    case 'replace_today': {
      if (!COURSE_IDS.includes(input.course_id)) return { error: 'Unknown course' };
      const today = dateKey();
      const tomorrow = addDaysKey(today, 1);

      // Decide which stages to mark done.
      // "consolidate" = first pass only (review stages stay so they become today's replacement)
      // "progress" or "switch" = all stages (user is fully done with this lecture and moving on)
      // Explicit all_stages flag overrides.
      const effectiveAllStages = input.all_stages != null
        ? input.all_stages
        : (input.fill_mode === 'progress' || input.fill_mode === 'switch');

      // Fetch today's day record FIRST — needed to scope the mark query to today only.
      const { data: todayDay } = await supabase
        .from('study_plan_days')
        .select('id, wake_time, bed_time')
        .eq('user_id', userId)
        .eq('plan_date', today)
        .maybeSingle();

      // Mark only TODAY's pending tasks for this session as completed.
      // Scoped to day_id so future-day instances are removed by the replan, not pre-emptively wiped.
      // Without the day_id scope, ALL pending tasks across ALL days get marked — which was causing
      // "replacing other lectures" because the global mark would wipe unrelated future tasks too.
      if (todayDay) {
        let markQuery = supabase.from('study_plan_tasks')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('day_id', todayDay.id)
          .eq('course_id', input.course_id)
          .eq('status', 'pending');
        if (input.session_id) markQuery = markQuery.eq('session_id', input.session_id);
        if (!effectiveAllStages) markQuery = markQuery.eq('task_type', 'first_pass');
        await markQuery;
      }

      // Ensure global completion stubs exist so the replan never reschedules these stages.
      // ensureStagesMarkedComplete handles all stages when effectiveAllStages=true.
      // For consolidate (effectiveAllStages=false) we only mark first_pass — create a stub
      // for it if none exists, so the replan's completedKeys set excludes it.
      if (todayDay && input.session_id) {
        if (effectiveAllStages) {
          await ensureStagesMarkedComplete(userId, input.course_id, input.session_id, todayDay.id);
        } else {
          const fpKey = `${input.course_id}:${input.session_id}:first_pass`;
          const { count } = await supabase
            .from('study_plan_tasks')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('generated_key', fpKey)
            .eq('status', 'completed');
          if (!count) {
            await supabase.from('study_plan_tasks').insert({
              user_id: userId,
              day_id: todayDay.id,
              course_id: input.course_id,
              session_id: String(input.session_id),
              task_type: 'first_pass',
              tool: 'notes',
              title: `Lecture ${input.session_id} - first pass notes`,
              duration_minutes: 50,
              start_time: '00:00',
              end_time: '00:00',
              generated_key: fpKey,
              status: 'completed',
              completed_at: new Date().toISOString()
            });
          }
        }
      }

      const replacements = [];
      if (todayDay) {
        // Fetch today's existing tasks (all statuses) — needed for cursor placement and key exclusion.
        const { data: allTodayTasks } = await supabase
          .from('study_plan_tasks')
          .select('start_time, end_time, duration_minutes, status, generated_key, task_type, course_id, session_id')
          .eq('day_id', todayDay.id)
          .order('start_time');

        // Reload completed keys (includes stubs from ensureStagesMarkedComplete above)
        const { data: completedRowsNow } = await supabase
          .from('study_plan_tasks')
          .select('generated_key')
          .eq('user_id', userId)
          .eq('status', 'completed');
        const completedKeysSet = new Set((completedRowsNow || []).map(r => r.generated_key).filter(Boolean));

        // Keys already on today — don't double-schedule these.
        const todayExistingKeys = new Set((allTodayTasks || []).map(t => t.generated_key).filter(Boolean));
        // Exclude completed + today-existing when building today's replacement backlog.
        // We intentionally do NOT exclude future-scheduled keys here — the replan for tomorrow
        // runs AFTER we pick today's replacement, so we pass the replacement keys to the replan
        // which prevents double-scheduling on tomorrow.
        const excludeForToday = new Set([...completedKeysSet, ...todayExistingKeys]);

        // Build a filtered backlog for today's replacement
        const [courses, progress, ratings, resources, quizStats, prefs] = await Promise.all([
          loadAllCourses(),
          getProgressFromDB(userId),
          supabase.from('study_course_ratings').select('*').eq('user_id', userId).then(r => r.data || []),
          supabase.from('study_resource_links').select('*').then(r => r.data || []),
          getQuizStats(userId),
          ensureStudyPreferences(userId)
        ]);
        const ratingsByKey = new Map(ratings.map(r => [`${r.course_id}:${r.session_id || '__course__'}`, r]));
        const fullBacklog = buildStudyBacklog({ courses, progress, ratingsByKey, resources, quizStats, completedKeys: excludeForToday, scheduledKeys: new Set(), today });

        // Apply fill_mode filter
        const fillMode = input.fill_mode || null;
        const filteredBacklog = fullBacklog.filter(task => {
          if (!fillMode) return true;
          if (fillMode === 'consolidate') {
            return task.course_id === input.course_id &&
              String(task.session_id) === String(input.session_id) &&
              task.task_type !== 'first_pass';
          }
          if (fillMode === 'progress') return task.course_id === input.course_id;
          if (fillMode === 'switch') return task.course_id !== input.course_id;
          return true;
        });

        const wake = todayDay.wake_time || prefs.wake_time || '08:30';
        const bed = todayDay.bed_time || prefs.bed_time || '23:30';
        const wakeMin = parseTimeMinutes(wake, '08:30');
        const bedMin = parseTimeMinutes(bed, '23:30');
        const dayOverride = (prefs.daily_overrides || {})[today] || {};
        const fixedBreaks = normalizeBreakBlocks(prefs, dayOverride);

        // Pending tasks only — these are the tasks that still need to happen today.
        const pendingTasksToday = (allTodayTasks || []).filter(t => t.status === 'pending' && t.task_type !== 'break');
        // Find the freed slot: start of the earliest completed task for this course/session today.
        // This is where the replacement should go — filling the actual freed time, not appended at end.
        const completedThisSession = (allTodayTasks || []).filter(t =>
          t.status === 'completed' && t.course_id === input.course_id &&
          String(t.session_id) === String(input.session_id) && t.task_type !== 'break'
        ).sort((a, b) => a.start_time.localeCompare(b.start_time));
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes() + 5;
        const freedSlotStartMin = completedThisSession.length > 0
          ? parseTimeMinutes(completedThisSession[0].start_time, wake)
          : null;
        const lastPendingEndMin = pendingTasksToday
          .reduce((max, t) => Math.max(max, parseTimeMinutes(t.end_time, wake)), wakeMin);
        // Prefer freed slot if it's still in the future; otherwise append after pending tasks.
        let cursor;
        if (freedSlotStartMin !== null && freedSlotStartMin >= nowMin) {
          cursor = snapToSlot(freedSlotStartMin);
        } else {
          cursor = snapToSlot(Math.max(lastPendingEndMin + 10, nowMin));
        }

        // usedMin from PENDING tasks only — completed task's minutes are freed, not consuming cap.
        const usedMin = pendingTasksToday.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);
        const cap = Math.min(effortCapMinutes(prefs.daily_effort, bedMin - wakeMin), availableStudyMinutes(wakeMin, bedMin, fixedBreaks, dayOverride, prefs));

        // Insert ONE replacement task into the freed slot only — not fill up to the day cap.
        // The freed slot's duration is used to size the replacement so it fits naturally.
        const freedSlotDuration = completedThisSession.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);
        const newTasks = [];
        const replacement = filteredBacklog[0];
        if (replacement && cursor < bedMin - 20) {
          const duration = Math.min(
            freedSlotDuration || replacement.duration_minutes,
            Math.max(20, bedMin - cursor)
          );
          const adjustedCursor = pushThroughFixedBreaks(cursor, duration, fixedBreaks);
          if (adjustedCursor + duration <= bedMin - 10) {
            const start = snapToSlot(adjustedCursor);
            const end = start + duration;
            newTasks.push({
              user_id: userId,
              day_id: todayDay.id,
              course_id: replacement.course_id,
              session_id: replacement.session_id,
              start_time: formatTimeMinutes(start),
              end_time: formatTimeMinutes(end),
              duration_minutes: duration,
              task_type: replacement.task_type,
              tool: STUDY_ORBIT_TOOLS.includes(replacement.tool) ? replacement.tool : 'agent',
              title: replacement.title,
              reasoning: replacement.reasoning,
              resource_url: replacement.resource_url,
              generated_key: replacement.generated_key,
              status: 'pending'
            });
          }
        }

        if (newTasks.length) {
          await supabase.from('study_plan_tasks').insert(newTasks);
        }

        // If today had no room (0-task day, too late, freed slot already past), insert the
        // replacement on tomorrow. We must capture the inserted row's ID and pass it as
        // protectedTaskIds so the replan's delete phase doesn't wipe it immediately.
        let protectedTaskIds = [];
        if (!newTasks.length && filteredBacklog.length) {
          const { data: tomorrowDay } = await supabase
            .from('study_plan_days')
            .select('id, wake_time, bed_time')
            .eq('user_id', userId)
            .eq('plan_date', tomorrow)
            .maybeSingle();
          if (tomorrowDay) {
            const { data: tomorrowTasks } = await supabase
              .from('study_plan_tasks')
              .select('start_time, end_time, duration_minutes, status, generated_key, task_type')
              .eq('day_id', tomorrowDay.id)
              .order('start_time');
            const tWake = tomorrowDay.wake_time || prefs.wake_time || '08:30';
            const tBed = tomorrowDay.bed_time || prefs.bed_time || '23:30';
            const tWakeMin = parseTimeMinutes(tWake, '08:30');
            const tBedMin = parseTimeMinutes(tBed, '23:30');
            const tDayOverride = (prefs.daily_overrides || {})[tomorrow] || {};
            const tBreaks = normalizeBreakBlocks(prefs, tDayOverride);
            const tPending = (tomorrowTasks || []).filter(t => t.status === 'pending' && t.task_type !== 'break');
            const tExistingKeys = new Set((tomorrowTasks || []).map(t => t.generated_key).filter(Boolean));
            const tLastEnd = tPending.reduce((max, t) => Math.max(max, parseTimeMinutes(t.end_time, tWake)), tWakeMin);
            const tCursor = snapToSlot(tLastEnd + 10);
            const tReplacement = filteredBacklog.find(t => !tExistingKeys.has(t.generated_key));
            if (tReplacement && tCursor < tBedMin - 20) {
              const dur = Math.min(tReplacement.duration_minutes, Math.max(20, tBedMin - tCursor));
              const adj = pushThroughFixedBreaks(tCursor, dur, tBreaks);
              if (adj + dur <= tBedMin - 10) {
                const tStart = snapToSlot(adj);
                const { data: inserted } = await supabase.from('study_plan_tasks').insert({
                  user_id: userId,
                  day_id: tomorrowDay.id,
                  course_id: tReplacement.course_id,
                  session_id: tReplacement.session_id,
                  start_time: formatTimeMinutes(tStart),
                  end_time: formatTimeMinutes(tStart + dur),
                  duration_minutes: dur,
                  task_type: tReplacement.task_type,
                  tool: STUDY_ORBIT_TOOLS.includes(tReplacement.tool) ? tReplacement.tool : 'agent',
                  title: tReplacement.title,
                  reasoning: tReplacement.reasoning,
                  resource_url: tReplacement.resource_url,
                  generated_key: tReplacement.generated_key,
                  status: 'pending'
                }).select('id');
                newTasks.push({ generated_key: tReplacement.generated_key });
                protectedTaskIds = (inserted || []).map(r => r.id).filter(Boolean);
              }
            }
          }
        }

        // Replan from tomorrow AFTER inserting replacements.
        // extraExcludeKeys: keys already on today or in the replacement, so tomorrow's replan
        // doesn't double-schedule them.
        // protectedTaskIds: IDs of the tomorrow task (if any) so the delete phase spares it.
        const todayPendingKeys = new Set(pendingTasksToday.map(t => t.generated_key).filter(Boolean));
        const replacementKeys = new Set(newTasks.map(t => t.generated_key).filter(Boolean));
        const todayAllKeys = new Set([...todayPendingKeys, ...replacementKeys]);
        await regenerateStudyPlan(userId, { fromDate: tomorrow, extraExcludeKeys: todayAllKeys, protectedTaskIds });

        // Return all pending tasks for today (existing + newly inserted)
        const { data: pendingToday } = await supabase
          .from('study_plan_tasks')
          .select('title, course_id, start_time, end_time, duration_minutes, task_type, reasoning')
          .eq('day_id', todayDay.id)
          .eq('status', 'pending')
          .neq('task_type', 'exam')
          .order('start_time');
        replacements.push(...(pendingToday || []));
      }

      return { ok: true, replacements };
    }
    case 'add_tasks_today': {
      const today = dateKey();

      const { data: todayDay } = await supabase
        .from('study_plan_days')
        .select('id, wake_time, bed_time')
        .eq('user_id', userId)
        .eq('plan_date', today)
        .maybeSingle();

      const tasks = [];
      if (todayDay) {
        // Fetch today's existing tasks — we're adding INTO the remaining free time,
        // not wiping and rebuilding (that would remove tasks the user hasn't done yet).
        const { data: allTodayTasks } = await supabase
          .from('study_plan_tasks')
          .select('start_time, end_time, duration_minutes, status, generated_key, task_type')
          .eq('day_id', todayDay.id)
          .order('start_time');

        const [completedRows, courses, progress, ratings, resources, quizStats, prefs] = await Promise.all([
          supabase.from('study_plan_tasks').select('generated_key').eq('user_id', userId).eq('status', 'completed').then(r => r.data || []),
          loadAllCourses(),
          getProgressFromDB(userId),
          supabase.from('study_course_ratings').select('*').eq('user_id', userId).then(r => r.data || []),
          supabase.from('study_resource_links').select('*').then(r => r.data || []),
          getQuizStats(userId),
          ensureStudyPreferences(userId)
        ]);

        const completedKeysSet = new Set(completedRows.map(r => r.generated_key).filter(Boolean));
        const todayExistingKeys = new Set((allTodayTasks || []).map(t => t.generated_key).filter(Boolean));
        const excludeKeys = new Set([...completedKeysSet, ...todayExistingKeys]);

        const ratingsByKey = new Map(ratings.map(r => [`${r.course_id}:${r.session_id || '__course__'}`, r]));
        const backlog = buildStudyBacklog({ courses, progress, ratingsByKey, resources, quizStats, completedKeys: excludeKeys, scheduledKeys: new Set(), today });

        const wake = todayDay.wake_time || prefs.wake_time || '08:30';
        const bed = todayDay.bed_time || prefs.bed_time || '23:30';
        const wakeMin = parseTimeMinutes(wake, '08:30');
        const bedMin = parseTimeMinutes(bed, '23:30');
        const dayOverride = (prefs.daily_overrides || {})[today] || {};
        const fixedBreaks = normalizeBreakBlocks(prefs, dayOverride);

        const pendingTasksToday = (allTodayTasks || []).filter(t => t.status === 'pending' && t.task_type !== 'break');
        const lastPendingEndMin = pendingTasksToday.reduce((max, t) => Math.max(max, parseTimeMinutes(t.end_time, wake)), wakeMin);
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes() + 5;
        let cursor = snapToSlot(Math.max(lastPendingEndMin + 10, nowMin));

        const usedMin = pendingTasksToday.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);
        const cap = Math.min(effortCapMinutes(prefs.daily_effort, bedMin - wakeMin), availableStudyMinutes(wakeMin, bedMin, fixedBreaks, dayOverride, prefs));

        const newTasks = [];
        let used = usedMin;
        for (const task of backlog) {
          if (used >= cap || cursor >= bedMin - 20) break;
          const duration = Math.min(task.duration_minutes, Math.max(20, bedMin - cursor));
          cursor = pushThroughFixedBreaks(cursor, duration, fixedBreaks);
          if (used + duration > cap || cursor + duration > bedMin - 10) break;
          const start = snapToSlot(cursor);
          const end = start + duration;
          newTasks.push({
            user_id: userId,
            day_id: todayDay.id,
            course_id: task.course_id,
            session_id: task.session_id,
            start_time: formatTimeMinutes(start),
            end_time: formatTimeMinutes(end),
            duration_minutes: duration,
            task_type: task.task_type,
            tool: STUDY_ORBIT_TOOLS.includes(task.tool) ? task.tool : 'agent',
            title: task.title,
            reasoning: task.reasoning,
            resource_url: task.resource_url,
            generated_key: task.generated_key,
            status: 'pending'
          });
          used += duration;
          cursor = snapToSlot(end + breakAfter(task.block_kind, 1));
        }

        if (newTasks.length) {
          await supabase.from('study_plan_tasks').insert(newTasks);
        }

        const { data } = await supabase
          .from('study_plan_tasks')
          .select('title, course_id, start_time, end_time, duration_minutes, task_type, reasoning')
          .eq('day_id', todayDay.id)
          .eq('status', 'pending')
          .neq('task_type', 'exam')
          .order('start_time');
        tasks.push(...(data || []));
      }

      return { ok: true, tasks };
    }
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

const MUTATING_ORBIT_TOOLS = new Set([
  'update_task_status', 'move_task', 'update_preferences',
  'update_course_rating', 'update_exam_date', 'trigger_replan', 'mark_work_done', 'replace_today', 'add_tasks_today'
]);

const COURSE_LABELS_MAP = { gtm: 'GTM', geopolitics: 'Geopolitics', digital_strategy: 'Digital Strategy', ibm: 'IBM', ism: 'ISM' };

function formatToolCallHuman(name, input) {
  const course = input.course_id ? (COURSE_LABELS_MAP[input.course_id] || input.course_id) : null;
  switch (name) {
    case 'mark_work_done': {
      const scope = input.session_id ? `Lecture ${input.session_id}` : 'all sessions';
      const filter = input.task_type ? ` (${input.task_type} tasks)` : input.tool ? ` (${input.tool} tasks)` : '';
      return `Mark ${course} — ${scope} as done${filter}`;
    }
    case 'trigger_replan':
      return `Rebuild study plan from ${input.from_date || 'today'}`;
    case 'update_task_status':
      return `Set task to ${input.status}`;
    case 'move_task':
      return `Move task to ${input.new_date}${input.start_time ? ` at ${input.start_time}` : ''}`;
    case 'update_preferences': {
      const parts = [];
      if (input.wakeTime) parts.push(`wake → ${input.wakeTime}`);
      if (input.bedTime) parts.push(`bed → ${input.bedTime}`);
      if (input.dailyEffort) parts.push(`effort → ${input.dailyEffort}`);
      if (input.dailyOverride) {
        const ov = input.dailyOverride;
        if (ov.skipCourses?.length) parts.push(`skip ${ov.skipCourses.map(c => COURSE_LABELS_MAP[c] || c).join(', ')} on ${ov.date}`);
        if (ov.studyMinutes) parts.push(`cap ${ov.date} at ${ov.studyMinutes} min`);
        if (ov.breaks?.length) parts.push(`block ${ov.breaks.map(b => `${b.start}–${b.end}`).join(', ')} on ${ov.date}`);
        if (ov.wakeTime) parts.push(`wake ${ov.date} → ${ov.wakeTime}`);
        if (ov.bedTime) parts.push(`bed ${ov.date} → ${ov.bedTime}`);
      }
      return `Update preferences: ${parts.join(', ') || 'no changes'}`;
    }
    case 'update_course_rating':
      return `Adjust ${course} ${input.field} → ${input.value}`;
    case 'update_exam_date':
      return `Move ${course} exam to ${input.new_date}${input.new_time ? ` at ${input.new_time}` : ''}`;
    case 'replace_today': {
      const sessionStr = input.session_id ? ` Lecture ${input.session_id}` : '';
      if (input.all_stages) return `Mark ${course}${sessionStr} fully done and fill today with other course tasks`;
      const modeLabel = input.fill_mode === 'consolidate' ? 'fill today with consolidation + quiz for this lecture'
        : input.fill_mode === 'progress' ? `fill today with next ${course} work`
        : input.fill_mode === 'switch' ? 'fill today with highest-priority work from another subject'
        : 'refill today from the study backlog';
      return `Mark ${course}${sessionStr} first-pass done and ${modeLabel}`;
    }
    case 'add_tasks_today':
      return `Fill today (and upcoming days) with tasks from your study backlog`;
    default:
      return name;
  }
}

app.get('/api/study/orbit-chat/history', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    const conv = await getOrbitConversation(userId);
    res.json({ messages: conv?.messages || [], summary: conv?.summary || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/study/orbit-chat/history', async (req, res) => {
  try {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Not logged in' });
    const userId = await getUserId(username);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    await supabase.from('chat_conversations')
      .delete()
      .eq('user_id', userId)
      .eq('course_id', '__orbit_agent__');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ORBIT_TOOL_LABELS = {
  update_task_status: 'Updating task status',
  move_task: 'Moving task',
  update_preferences: 'Updating preferences',
  update_course_rating: 'Adjusting course difficulty',
  update_exam_date: 'Updating exam date',
  trigger_replan: 'Rebuilding your plan',
  store_observation: 'Remembering that',
  mark_work_done: 'Marking work as done',
  replace_today: 'Scheduling your replacement task',
  add_tasks_today: 'Building your schedule'
};

app.post('/api/study/orbit-chat', async (req, res) => {
  // Stream NDJSON events to the client
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  try {
    const username = getUser(req);
    if (!username) { emit({ type: 'error', message: 'Not logged in' }); return res.end(); }
    const [userId, { anthropic_key: apiKey }] = await Promise.all([getUserId(username), getUserKeys(username)]);
    if (!apiKey) { emit({ type: 'error', message: 'No Anthropic API key set. Add it in Settings.' }); return res.end(); }
    if (!userId) { emit({ type: 'error', message: 'User not found' }); return res.end(); }

    const { message, snapshot, confirmTools } = req.body;
    if (!message) { emit({ type: 'error', message: 'message required' }); return res.end(); }

    const [memory, conv] = await Promise.all([
      getOrbitAgentMemory(userId),
      getOrbitConversation(userId)
    ]);

    // ── Branch B: user approved a pending proposal ────────────────────────────
    if (confirmTools?.length) {
      const toolResults = [];
      for (const tu of confirmTools) {
        emit({ type: 'tool_call', tool: tu.name, label: ORBIT_TOOL_LABELS[tu.name] || tu.name });
        try {
          const result = await executeOrbitTool(userId, tu.name, tu.input || {});
          console.log(`[orbit-confirm] ${tu.name}`, JSON.stringify(tu.input).slice(0, 200), '→', JSON.stringify(result).slice(0, 300));
          toolResults.push({ name: tu.name, result });
        } catch (toolErr) {
          console.error(`[orbit-confirm] ${tu.name} THREW:`, toolErr.message);
          toolResults.push({ name: tu.name, result: { error: toolErr.message } });
        }
      }

      // Surface any tool errors
      const toolError = toolResults.find(r => r.result?.error);
      if (toolError) {
        const errReply = `Something went wrong: ${toolError.result.error}`;
        emit({ type: 'reply', text: errReply, mutated: false });
        return res.end();
      }

      // Build a specific reply based on which tool ran and what it returned
      let confirmReply = 'Done — your plan has been updated.';
      const replaceResult = toolResults.find(r => r.name === 'replace_today')?.result;
      const addResult = toolResults.find(r => r.name === 'add_tasks_today')?.result;
      const taskList = replaceResult?.replacements || addResult?.tasks;
      if (taskList?.length) {
        const shown = taskList.slice(0, 3)
          .map(t => `${COURSE_LABELS_MAP[t.course_id] || t.course_id} — ${t.title} (${t.start_time}–${t.end_time})`)
          .join('; ');
        const overflow = taskList.length > 3 ? ` + ${taskList.length - 3} more` : '';
        const firstReason = taskList[0]?.reasoning ? ` ${taskList[0].reasoning.split('.')[0]}.` : '';
        confirmReply = `Done. Here's what's now on your schedule for today: ${shown}${overflow}.${firstReason}`;
      } else if (taskList) {
        confirmReply = 'Done — plan updated, but no new tasks could be scheduled for today (backlog may be clear). Check future days.';
      }

      try {
        await saveOrbitConversation(userId, conv, [
          { role: 'assistant', content: confirmReply, ts: Date.now() }
        ], apiKey);
      } catch (_) {}
      emit({ type: 'reply', text: confirmReply, mutated: true });
      return res.end();
    }

    // ── Branch A: normal — ask Claude, then propose or reply ─────────────────
    const systemPrompt = buildOrbitSystemPrompt(snapshot, memory, conv?.summary || '');
    const history = (conv?.messages || []).slice(-6);
    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message }
    ];

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: systemPrompt, tools: ORBIT_TOOLS, messages })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Claude API error');

    const assistantContent = data.content || [];
    const claudeText = assistantContent.find(b => b.type === 'text')?.text || '';
    const toolUses = assistantContent.filter(b => b.type === 'tool_use');

    const mutatingTools = toolUses.filter(t => MUTATING_ORBIT_TOOLS.has(t.name));
    const nonMutatingTools = toolUses.filter(t => !MUTATING_ORBIT_TOOLS.has(t.name));

    // Always execute non-mutating tools immediately (store_observation etc.)
    for (const tu of nonMutatingTools) {
      try { await executeOrbitTool(userId, tu.name, tu.input || {}); } catch (_) {}
    }

    if (mutatingTools.length > 0) {
      // Show a proposal — don't execute yet
      const steps = mutatingTools.map(tu => formatToolCallHuman(tu.name, tu.input || {}));
      const pendingTools = mutatingTools.map(tu => ({ name: tu.name, input: tu.input || {} }));
      // If replace_today was called without fill_mode, signal the UI to show the dropdown
      const needsModeChoice = mutatingTools.some(t => t.name === 'replace_today' && !t.input?.fill_mode);
      try {
        await saveOrbitConversation(userId, conv, [
          { role: 'user', content: message, ts: Date.now() }
        ], apiKey);
      } catch (_) {}
      console.log(`[orbit-chat] emitting proposal — steps=${steps.length} needsModeChoice=${needsModeChoice}`);
      emit({ type: 'proposal', explanation: claudeText, steps, tools: pendingTools, fill_mode_required: needsModeChoice });
      return res.end();
    }

    // No mutating tools — plain reply
    const reply = claudeText;
    try {
      await saveOrbitConversation(userId, conv, [
        { role: 'user', content: message, ts: Date.now() },
        { role: 'assistant', content: reply, ts: Date.now() }
      ], apiKey);
    } catch (saveErr) {
      console.error('[orbit-chat] save failed:', saveErr.message);
    }

    console.log(`[orbit-chat] emitting plain reply — replyLength=${reply.length}`);
    emit({ type: 'reply', text: reply, mutated: false });
    res.end();
  } catch (err) {
    console.error('[orbit-chat] error:', err.message);
    emit({ type: 'error', message: err.message });
    res.end();
  }
});

// ── Claude API proxy ──────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { anthropic_key: apiKey } = await getUserKeys(username);
  if (!apiKey) return res.status(400).json({ error: 'No Anthropic API key set. Add it in Settings.' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25,prompt-caching-2024-07-31'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generate questions via Claude ─────────────────────────────────────────────

app.post('/api/generate-questions', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { courseId, sessionId, count = 5 } = req.body;
  const { anthropic_key: apiKey } = await getUserKeys(username);
  if (!apiKey) return res.status(400).json({ error: 'No Anthropic API key set. Add it in Settings.' });

  const course = await loadCourse(courseId);
  const session = course.sessions.find(s => s.id === sessionId) || course.sessions[0];

  const prompt = `You are a Bocconi University exam question generator.

Course: ${course.name}
Exam format: ${course.exam_format}
Session: ${session.title}
Topics: ${session.topics.join(', ')}

Generate ${count} exam-style questions for this session.

For MCQ courses (GTM, Geopolitics, IBM), use the Bocconi style: "Which of the following statements is NOT correct?" with 4 options (a, b, c, d) where exactly one is false.

For Digital Strategy, generate a mix of MCQ and open-ended questions.

For ISM, generate open-ended questions like "Describe X and explain how it applies to Y."

Return ONLY a valid JSON array with this format:
[
  {
    "id": "gen-${courseId}-001",
    "session": "${sessionId || 'general'}",
    "type": "mcq_not_correct",
    "question": "...",
    "options": {"a": "...", "b": "...", "c": "...", "d": "..."},
    "correct": "b",
    "explanation": "..."
  }
]

For open questions use type "open" with fields: question, model_answer, key_points (array).
Make questions genuinely challenging and exam-realistic.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    const text = data.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      res.json(JSON.parse(jsonMatch[0]));
    } else {
      res.status(500).json({ error: 'Could not parse generated questions' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── OpenAI TTS proxy ──────────────────────────────────────────────────────────

app.post('/api/tts', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { text } = req.body;
  const { openai_key: apiKey } = await getUserKeys(username);
  if (!apiKey) return res.status(400).json({ error: 'No OpenAI API key set. Add it in Settings.' });

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model: 'tts-1-hd', voice: 'nova', input: text, speed: 1.0 })
    });
    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || 'TTS failed' });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streaming TTS for voice conversation — pipes bytes through as OpenAI generates them.
// Cuts first-audio latency from ~1-3s (buffered) to ~200-400ms (streamed).
// Uses tts-1 (not tts-1-hd) for ~2x speed — quality diff is inaudible in conversation.
app.post('/api/tts/stream', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { text, voice = 'nova', speed = 1.05 } = req.body;
  const { openai_key: apiKey } = await getUserKeys(username);
  if (!apiKey) return res.status(400).json({ error: 'No OpenAI API key set. Add it in Settings.' });
  if (!text) return res.status(400).json({ error: 'text required' });

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice,
        input: text,
        speed,
        response_format: 'mp3'
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(500).json({ error: err.error?.message || 'TTS failed' });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    for await (const chunk of response.body) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// ── Voice conversation endpoints ──────────────────────────────────────────────

// Whisper STT — accepts base64 audio, returns transcript
app.post('/api/voice/transcribe', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });

  const { openai_key: apiKey } = await getUserKeys(username);
  if (!apiKey) return res.status(400).json({ error: 'No OpenAI API key set. Add it in Settings.' });

  const { audio, mimeType = 'audio/webm' } = req.body;
  if (!audio) return res.status(400).json({ error: 'audio required' });

  try {
    const buffer = Buffer.from(audio, 'base64');
    const extension = mimeType.includes('mp4') ? 'mp4'
                    : mimeType.includes('wav') ? 'wav'
                    : mimeType.includes('ogg') ? 'ogg'
                    : 'webm';
    const blob = new Blob([buffer], { type: mimeType });
    const form = new FormData();
    form.append('file', blob, `audio.${extension}`);
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('response_format', 'json');
    form.append('language', 'en');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message || 'Transcription failed' });
    res.json({ text: data.text || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streaming Claude chat for voice — forwards Anthropic SSE events directly to client
app.post('/api/voice/chat', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });

  const { anthropic_key: apiKey } = await getUserKeys(username);
  if (!apiKey) return res.status(400).json({ error: 'No Anthropic API key set. Add it in Settings.' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify({ ...req.body, stream: true })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Upstream error' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    for await (const chunk of response.body) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// Summarise a chunk of conversation history (used for long-running voice chats
// so Claude keeps long-term context without paying for the whole transcript on every turn).
app.post('/api/voice/summarize', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });

  const { anthropic_key: apiKey } = await getUserKeys(username);
  if (!apiKey) return res.status(400).json({ error: 'No Anthropic API key set. Add it in Settings.' });

  const { priorSummary = '', newMessages = [] } = req.body || {};
  if (!Array.isArray(newMessages) || newMessages.length === 0) {
    return res.json({ summary: priorSummary });
  }

  const transcript = newMessages
    .map(m => `${m.role === 'user' ? 'Ricky' : 'Tutor'}: ${m.content}`)
    .join('\n');
  const prior = priorSummary.trim()
    ? `Prior summary:\n${priorSummary.trim()}\n\n`
    : '';

  const prompt = `${prior}New exchanges to fold in:\n${transcript}\n\nProduce an updated 3-5 sentence prose summary of the conversation so far. Cover: key topics covered, concepts Ricky found difficult or wanted clarified, decisions made, and where the conversation left off. Be specific, not generic. Prose only — no bullet points, no headings.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Summarisation failed' });
    }
    const summary = (data.content?.[0]?.text || '').trim();
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Lecture primer via Claude ─────────────────────────────────────────────────

app.post('/api/lecture-primer', async (req, res) => {
  const username = getUser(req);
  if (!username) return res.status(401).json({ error: 'Not logged in' });
  const { courseId, sessionId } = req.body;
  const { anthropic_key: apiKey } = await getUserKeys(username);
  if (!apiKey) return res.status(400).json({ error: 'No Anthropic API key set. Add it in Settings.' });

  const course = await loadCourse(courseId);

  let prompt;
  if (!sessionId) {
    const sessionList = course.sessions.map(s => `- ${s.title}: ${s.topics.join(', ')}`).join('\n');
    prompt = `You are helping a Bocconi University student prepare to study for an exam. Generate a spoken, conversational 4–5 minute course overview.

Course: ${course.name}
Exam format: ${course.exam_format}
Lectures covered:
${sessionList}

Write 400–500 words that:
1. Opens by explaining what this course is fundamentally about and why it matters
2. Walks through the arc of the course — how the topics build on each other
3. Highlights the 3–4 most exam-critical themes and what to watch for
4. Closes with a mindset or framing to carry into revision

Write as if speaking directly to the student. Flowing prose, conversational tone, no bullet points, no greetings.`;
  } else {
    const session = course.sessions.find(s => s.id === sessionId) || course.sessions[0];
    prompt = `You are helping a Bocconi University student prepare before studying a lecture. Generate a spoken, conversational 2–3 minute primer.

Course: ${course.name}
Lecture: ${session.title} (Sessions ${session.id})
Topics: ${session.topics.join(', ')}

Write 250–350 words that:
1. Opens by framing what this lecture is about in plain language
2. Explains the 2–3 key concepts and how they connect to each other
3. Flags what is exam-relevant and what to pay close attention to
4. Closes with one sentence the student can hold in mind as they study

Write as if speaking directly to the student. Flowing prose, conversational tone, no bullet points, no greetings.`;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (text) {
      res.json({ text });
    } else {
      res.status(500).json({ error: 'Empty response from Claude' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Error handling ────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'File too large. Maximum request size is 50 MB.' });
  }
  next(err);
});

// Keep the process alive even if an unexpected error escapes a route.
// Without this, an uncaught exception kills the server mid-request → client sees ERR_CONNECTION_RESET.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function start() {
  // Verify Supabase connection + load sessions + ensure storage bucket exists
  try {
    const { error: dbError } = await supabase.from('users').select('id').limit(1);
    if (dbError) {
      console.error('\n⚠️  Supabase tables not found. Run schema.sql in the Supabase SQL Editor first.');
      console.error('   Dashboard → SQL Editor → paste schema.sql → Run\n');
    } else {
      console.log('✓  Supabase connected');
      await loadSessions();
    }

    // Create storage bucket if it doesn't exist
    const { error: bucketError } = await supabase.storage.createBucket('study-files', { public: true });
    if (!bucketError || bucketError.message?.includes('already exists')) {
      console.log('✓  Storage bucket ready');
    }
  } catch (e) {
    console.error('Supabase init error:', e.message);
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🎓 Bocconi Study App → http://localhost:${PORT}\n`);
    console.log('Exams:');
    console.log('  18 May — GTM Strategies');
    console.log('  21 May — Geopolitics');
    console.log('  22 May — Digital Strategy');
    console.log('  27 May — IBM + ISM (double day)\n');
  });
}

start();
