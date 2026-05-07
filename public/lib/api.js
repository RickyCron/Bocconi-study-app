import { state, patch, emit } from '../store/store.js';
import { showToast } from './toast.js';
import { isOrbitBreak } from './utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _json(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `${r.status} ${r.statusText}`);
  }
  return r.json();
}

function _post(url, body) {
  return _json(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const auth = {
  me:        ()      => _json('/api/auth/me'),
  check:     (u)     => _post('/api/auth/check', { username: u }),
  login:     (u, p)  => _post('/api/auth/login', { username: u, pin: p }),
  register:  (u, p)  => _post('/api/auth/register', { username: u, pin: p }),
  verifyPin: (p)     => _post('/api/auth/verify-pin', { pin: p }),
  changePin: (c, n)  => _post('/api/auth/change-pin', { currentPin: c, newPin: n }),
  logout:    ()      => _post('/api/auth/logout', {}),
};

// ── Core data ─────────────────────────────────────────────────────────────────

export async function loadAppData() {
  const [courses, questions, progress] = await Promise.all([
    _json('/api/courses'),
    _json('/api/questions'),
    _json('/api/progress'),
  ]);
  state.courses  = courses.courses;
  state.questions = questions;
  state.progress  = progress;
  emit('courses:loaded', state.courses);
  checkApiStatus();
}

export function saveProgress() {
  fetch('/api/progress', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(state.progress),
  });
}

function checkApiStatus() {
  const el = document.getElementById('api-status');
  if (el) el.textContent = 'Status: Ready';
}

// ── Study Orbit ───────────────────────────────────────────────────────────────

export async function loadStudyOrbit(force = false, silent = false) {
  if (state.orbit.loading) return;
  if (state.orbit.data && !force) { emit('orbit:data'); return; }
  patch('orbit.loading', true);
  if (!silent) emit('orbit:loading');
  try {
    const data = await _json('/api/study-orbit');
    state.orbit.data    = data;
    state.orbit.error   = null;
    state.orbit.loading = false;
    if (!data.setupComplete && !state.orbit.wizardOpen && !force) {
      state.orbit.wizardOpen = true;
      state.orbit.wizardStep = 0;
      state.orbit.wizardValues = null;
    }
    emit('orbit:data');
  } catch (err) {
    state.orbit.error   = err.message;
    state.orbit.loading = false;
    emit('orbit:error', err.message);
  }
}

export async function mutateOrbit(url, body, method = 'POST') {
  emit('orbit:busy', true);
  try {
    const data = await _json(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    state.orbit.data = data;
    emit('orbit:data');
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  } finally {
    emit('orbit:busy', false);
  }
}

export async function saveOrbitPrefs(patch_) {
  const prefs = { ...(state.orbit.data?.preferences || {}), ...patch_ };
  return mutateOrbit('/api/study/preferences', prefs);
}

export async function saveOrbitDayTime(date, field, value) {
  const dailyOverrides = { ...(state.orbit.data?.preferences?.dailyOverrides || {}) };
  dailyOverrides[date] = { ...(dailyOverrides[date] || {}), [field]: value };
  return saveOrbitPrefs({ dailyOverrides });
}

export async function saveOrbitRating(courseId, sessionId, field, value) {
  const ratings = state.orbit.data?.ratings || [];
  const current = ratings.find(r => r.courseId === courseId && r.sessionId === sessionId)
    || { courseId, sessionId, slideLoad: 'medium', lectureDepth: 'medium', requiredDepth: 'medium', syllabusDifficulty: 'medium', effort: 'medium' };
  const next = { ...current, [field]: value };
  return mutateOrbit('/api/study/ratings', { ratings: [next] });
}

export async function setTaskStatus(taskId, newStatus) {
  const task = findTask(taskId);
  if (!task || isOrbitBreak(task)) return;
  const prev = task.status;
  task.status = newStatus;
  emit('orbit:data');
  try {
    await fetch(`/api/study/tasks/${taskId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: newStatus }),
    }).then(r => { if (!r.ok) throw new Error('Update failed'); });
    const data = await _json('/api/study/plan/replan-future', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (data) { state.orbit.data = data; emit('orbit:data'); }
  } catch (err) {
    task.status = prev;
    emit('orbit:data');
    showToast(err.message, 'error');
  }
}

export async function deleteTask(taskId) {
  // Optimistic removal
  for (const day of state.orbit.data?.days || []) {
    const idx = day.tasks.findIndex(t => t.id === taskId);
    if (idx !== -1) { day.tasks.splice(idx, 1); break; }
  }
  emit('orbit:data');
  try {
    const r = await fetch(`/api/study/tasks/${taskId}`, { method: 'DELETE' });
    if (!r.ok) throw new Error('Delete failed');
  } catch (err) {
    showToast('Could not delete task', 'error');
    await loadStudyOrbit(true);
  }
}

// Move task with true deep-copy snapshot for rollback
export async function moveTaskToDate(taskId, targetDate) {
  const task = findTask(taskId);
  if (!task || isOrbitBreak(task)) return;

  const snapshot = JSON.parse(JSON.stringify(state.orbit.data));

  // Optimistic update
  for (const day of state.orbit.data.days) {
    day.tasks = day.tasks.filter(t => t.id !== taskId);
  }
  const targetDay = state.orbit.data.days.find(d => d.date === targetDate);
  if (targetDay) {
    task.status = 'pending';
    targetDay.tasks.push(task);
    targetDay.tasks.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }
  emit('orbit:data');

  try {
    const data = await _post(`/api/study/tasks/${taskId}/move`, { targetDate });
    state.orbit.data = data;
    emit('orbit:data');
  } catch (err) {
    state.orbit.data = snapshot;
    emit('orbit:data');
    showToast(err.message, 'error');
  }
}

export async function addTaskToDay(date) {
  const today = state.orbit.data?.today;
  try {
    const url = date === today
      ? '/api/study/tasks/add-today'
      : '/api/study/plan/regenerate';
    const body = date === today ? {} : { fromDate: date };
    const data = await _post(url, body);
    state.orbit.data = data;
    emit('orbit:data');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export async function regenerateOrbit() {
  return mutateOrbit('/api/study/plan/regenerate', {});
}

// ── Task helpers ──────────────────────────────────────────────────────────────

export function findTask(taskId) {
  for (const day of state.orbit.data?.days || []) {
    const t = day.tasks.find(t => t.id === taskId);
    if (t) return t;
  }
  return null;
}

// ── Orbit agent chat ──────────────────────────────────────────────────────────

export async function loadOrbitChatHistory() {
  if (state.orbitChat.initialized) return;
  state.orbitChat.initialized = true;
  try {
    const data = await _json('/api/study/orbit-chat/history');
    state.orbitChat.messages = data.messages || [];
    emit('orbit:chat:messages');
  } catch {}
}

export async function clearOrbitChatHistory() {
  if (!confirm('Clear Orbit conversation history?')) return;
  await fetch('/api/study/orbit-chat/history', { method: 'DELETE' });
  state.orbitChat.messages = [];
  state.orbitChat.initialized = true;
  emit('orbit:chat:messages');
}

export async function streamOrbitChat(body) {
  const res = await fetch('/api/study/orbit-chat', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const result = { reply: '', mutated: false, proposal: null };

  const processLine = line => {
    if (!line.trim()) return;
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    if (evt.type === 'tool_call') {
      state.orbitChat.loadingLabel = evt.label || evt.tool;
      emit('orbit:chat:loading-label', state.orbitChat.loadingLabel);
    } else if (evt.type === 'reply') {
      result.reply   = evt.text;
      result.mutated = evt.mutated;
    } else if (evt.type === 'proposal') {
      result.proposal = {
        explanation:       evt.explanation,
        steps:             evt.steps,
        tools:             evt.tools,
        fill_mode_required: evt.fill_mode_required || false,
      };
    } else if (evt.type === 'error') {
      throw new Error(evt.message);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(processLine);
    }
    if (buffer.trim()) processLine(buffer);
  } catch (streamErr) {
    if (!result.reply && !result.proposal) throw streamErr;
  }

  return result;
}

// ── Chat localStorage ─────────────────────────────────────────────────────────
// Chat data lives in localStorage (large) + synced to server.
// This is NOT part of the reactive store — it's too large to be reactive.

const CHAT_STORE = 'bocconi_chats';

export function loadChatData() {
  try { return JSON.parse(localStorage.getItem(CHAT_STORE)) || { conversations: {}, memory: {} }; }
  catch { return { conversations: {}, memory: {} }; }
}

function _stripAttachmentData(conversations) {
  const stripped = {};
  for (const [courseId, convList] of Object.entries(conversations)) {
    stripped[courseId] = convList.map(conv => ({
      ...conv,
      messages: (conv.messages || []).map(msg => {
        if (!Array.isArray(msg.content)) return msg;
        return {
          ...msg,
          content: msg.content.map(block => {
            if ((block.type === 'document' || block.type === 'image') && block.source?.data) {
              const { data: _omit, ...rest } = block.source;
              return { ...block, source: { ...rest, data: '[stripped]' } };
            }
            return block;
          }),
        };
      }),
    }));
  }
  return stripped;
}

export function saveChatData(data) {
  fetch('/api/conversations/sync', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ conversations: data.conversations }),
  }).catch(() => {});
  const stripped = _stripAttachmentData(data.conversations);
  try { localStorage.setItem(CHAT_STORE, JSON.stringify({ ...data, conversations: stripped })); }
  catch (e) { console.warn('localStorage quota exceeded', e); }
}

export async function syncChatsFromServer() {
  try {
    const { conversations: serverConvs } = await _json('/api/conversations');
    if (!serverConvs) return;
    const local = loadChatData();
    for (const [courseId, convList] of Object.entries(serverConvs)) {
      if (!local.conversations[courseId]) local.conversations[courseId] = [];
      for (const serverConv of convList) {
        const idx = local.conversations[courseId].findIndex(c => c.id === serverConv.id);
        if (idx === -1) {
          local.conversations[courseId].push(serverConv);
        } else if (serverConv.updated > (local.conversations[courseId][idx].updated || 0)) {
          local.conversations[courseId][idx] = serverConv;
        }
      }
    }
    const stripped = _stripAttachmentData(local.conversations);
    try { localStorage.setItem(CHAT_STORE, JSON.stringify({ ...local, conversations: stripped })); }
    catch {}
  } catch {}
}

export function saveCurrentConv() {
  const { courseContext, currentConvId, history } = state.chat;
  if (!courseContext || !currentConvId || history.length === 0) return;
  const data = loadChatData();
  if (!data.conversations[courseContext]) data.conversations[courseContext] = [];
  const convs = data.conversations[courseContext];
  const existing = convs.find(c => c.id === currentConvId);
  const firstUser = history.find(m => m.role === 'user');
  const firstUserText = firstUser
    ? (Array.isArray(firstUser.content)
        ? (firstUser.content.find(b => b.type === 'text')?.text || '[attachment]')
        : firstUser.content)
    : '';
  const title = firstUserText
    ? firstUserText.slice(0, 45) + (firstUserText.length > 45 ? '…' : '')
    : 'Conversation';
  if (existing) {
    Object.assign(existing, { messages: history.slice(), title, draft: false, updated: Date.now() });
  } else {
    convs.push({ id: currentConvId, title, created: Date.now(), updated: Date.now(), draft: false, messages: history.slice() });
  }
  saveChatData(data);
}

export function cleanupDraft() {
  const { courseContext, currentConvId, history } = state.chat;
  if (!courseContext || !currentConvId || history.length > 0) return;
  const data = loadChatData();
  if (!data.conversations[courseContext]) return;
  data.conversations[courseContext] = data.conversations[courseContext].filter(c => c.id !== currentConvId);
  saveChatData(data);
}
