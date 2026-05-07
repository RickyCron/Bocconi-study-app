import { EXAM_DATES } from '../config.js';
import { state } from '../store/store.js';

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function daysUntil(date) {
  return Math.ceil((date - new Date()) / 86400000);
}

// Returns a YYYY-MM-DD string for a date ± N days (safe across DST)
export function addDaysKey(key, days) {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatOrbitDate(key, long = false) {
  const d = new Date(`${key}T12:00:00`);
  return d.toLocaleDateString('en-GB', long
    ? { weekday: 'long', day: 'numeric', month: 'long' }
    : { weekday: 'short', day: 'numeric', month: 'short' });
}

// Returns effective exam date, honouring per-course overrides stored in orbit prefs
export function effectiveExamDate(courseId) {
  const ov = (state.orbit.data?.preferences?.examOverrides || {})[courseId];
  if (ov?.date) return new Date(ov.date + 'T12:00:00');
  return EXAM_DATES[courseId];
}

export function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

export function getCoverage(courseId) {
  if (!state.courses) return 0;
  const course = state.courses[courseId];
  const p = state.progress[courseId] || {};
  const done = course.sessions.filter(s => p[s.id]?.notesDone).length;
  return Math.round((done / course.sessions.length) * 100);
}

export function getAvgScore(courseId) {
  const p = state.progress[courseId] || {};
  const scores = Object.values(p)
    .filter(s => s && typeof s === 'object' && s.quizScore !== undefined)
    .map(s => s.quizScore);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export function getWrongCount(courseId) {
  if (courseId) return (state.progress[courseId]?.wrongQuestions || []).length;
  return Object.values(state.progress).reduce((sum, p) => sum + (p?.wrongQuestions?.length || 0), 0);
}

export function urgencyScore(courseId) {
  const days = daysUntil(effectiveExamDate(courseId));
  const coverage = getCoverage(courseId) / 100;
  const score = getAvgScore(courseId);
  const perfFactor = score !== null ? (1 - score / 100) : 0.5;
  return ((1 - coverage) / Math.max(days, 1)) * (1 + perfFactor);
}

export function urgencyColor(u) {
  if (u > 0.01) return 'var(--red)';
  if (u > 0.005) return 'var(--c-gtm)';
  return 'var(--green)';
}

export function isOrbitBreak(task) {
  return task.status === 'break' || task.taskType === 'break' ||
    task.taskType === 'long_break' || task.tool === 'break';
}

export function stageLabel(type) {
  return ({
    first_pass:       'First pass',
    knowledge_update: 'Knowledge update',
    deep_work:        'Deep work',
    retrieval:        'Retrieval',
    spaced_review:    'Spaced review',
    mixed_review:     'Mixed review',
  })[type] || (type || '').replace(/[-_]/g, ' ');
}

export function taskUsesNotesMode(task) {
  return task?.tool === 'notes' || task?.taskType === 'first_pass';
}

export function animateProgressBars(container) {
  const fills = (container || document).querySelectorAll('.progress-fill:not(.animated):not(#tts-progress-bar)');
  fills.forEach((el, i) => {
    const target = el.style.width || '0%';
    el.style.width = '0%';
    el.style.setProperty('--progress-target', target);
    setTimeout(() => el.classList.add('animated'), i * 80 + 100);
  });
}

export function animateStaggerItems(container) {
  const items = (container || document).querySelectorAll('.stagger-item');
  items.forEach((el, i) => {
    el.classList.remove('go');
    void el.offsetWidth;
    el.style.animationDelay = `${i * 60}ms`;
    el.classList.add('go');
  });
}
