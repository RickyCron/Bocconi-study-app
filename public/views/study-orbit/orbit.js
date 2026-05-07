import { state, on, off, emit } from '../../store/store.js';
import { navigate }             from '../../router.js';
import { escapeHtml, formatOrbitDate, isOrbitBreak, addDaysKey, stageLabel, animateStaggerItems } from '../../lib/utils.js';
import { showToast }            from '../../lib/toast.js';
import { GENERATING_MSGS }      from '../../config.js';
import {
  loadStudyOrbit,
  mutateOrbit,
  saveOrbitPrefs,
  saveOrbitDayTime,
  saveOrbitRating,
  setTaskStatus,
  deleteTask,
  moveTaskToDate,
  addTaskToDay,
  regenerateOrbit,
  findTask,
} from '../../lib/api.js';
import { renderWizard, wizardValues } from './orbit-wizard.js';
import { renderSetup }               from './orbit-setup.js';
import { renderTopTask, renderCalendarDay, renderWeekGrid } from './orbit-calendar.js';
import { renderDrawer }              from './orbit-drawer.js';
import { mountChat, unmountChat }    from './orbit-chat.js';

// ── Generating screen ─────────────────────────────────────────────────────────

let _genTimer = null;
let _genIdx = 0;

function _startGenerating(container) {
  _genIdx = 0;
  _genTimer = setInterval(() => {
    _genIdx++;
    _renderInner(container);
  }, 2200);
}

function _stopGenerating() {
  clearInterval(_genTimer);
  _genTimer = null;
}

function _renderGenerating() {
  const msg = GENERATING_MSGS[_genIdx % GENERATING_MSGS.length];
  return `
    <div class="orbit-generating">
      <div class="generating-orb"></div>
      <h2>Building your plan</h2>
      <p class="generating-msg">${escapeHtml(msg)}</p>
      <div class="generating-dots"><span></span><span></span><span></span></div>
    </div>`;
}

// ── Task helpers ──────────────────────────────────────────────────────────────

function _getTopTask() {
  const days   = state.orbit.data?.days || [];
  const today  = state.orbit.data?.today;
  const upcoming = days.filter(d => !today || d.date >= today);
  for (const day of upcoming) {
    const t = (day.tasks || []).find(t => !isOrbitBreak(t) && t.taskType !== 'exam' && t.status === 'pending');
    if (t) return t;
  }
  for (const day of upcoming) {
    const t = (day.tasks || []).find(t => !isOrbitBreak(t) && t.taskType !== 'exam' && t.status !== 'completed');
    if (t) return t;
  }
  return null;
}

function _orbitTutorStarter(task) {
  const course  = state.courses?.[task.courseId];
  const session = course?.sessions?.find(s => s.id === task.sessionId);
  const lecture = session ? `Lecture ${session.id}: ${session.title}` : task.title;
  const stage   = stageLabel(task.taskType).toLowerCase();
  if (task.taskType === 'first_pass' || task.tool === 'notes') return `I am writing notes for ${lecture}. Help me build exam-ready notes step by step.`;
  if (task.taskType === 'deep_work')        return `I want to deepen my understanding of ${lecture}. Help me reason through the structure, traps, and exam angle.`;
  if (task.taskType === 'knowledge_update') return `Help me update my understanding of ${lecture}. Find gaps, sharpen the key ideas, and test me as we go.`;
  return `Help me study ${lecture} for this ${stage} block.`;
}

// ── Inner render (decides what to show) ──────────────────────────────────────

function _renderInner(container) {
  if (!state.courses) {
    container.innerHTML = `
      <div class="page-hd"><div><h1 class="page-title">Study Orbit</h1><div class="page-sub">Loading…</div></div></div>
      <div class="orbit-shell">
        <div class="skeleton" style="height:180px;border-radius:1rem;"></div>
        <div class="skeleton" style="height:360px;border-radius:1rem;"></div>
      </div>`;
    return;
  }

  if (_genTimer) {
    container.innerHTML = _renderGenerating();
    return;
  }

  if (state.orbit.wizardOpen) {
    container.innerHTML = renderWizard();
    return;
  }

  if (!state.orbit.data) {
    if (state.orbit.error) {
      container.innerHTML = `
        <div class="orbit-empty">
          <div class="orbit-empty-title">Study Orbit needs its tables.</div>
          <div class="orbit-empty-text">${escapeHtml(state.orbit.error)}. Run db/study-orbit-schema.sql in Supabase, then refresh.</div>
        </div>`;
      return;
    }
    container.innerHTML = `
      <div class="page-hd"><div><h1 class="page-title">Study Orbit</h1></div></div>
      <div class="orbit-shell">
        <div class="skeleton" style="height:180px;border-radius:1rem;"></div>
        <div class="skeleton" style="height:360px;border-radius:1rem;"></div>
      </div>`;
    loadStudyOrbit();
    return;
  }

  const data      = state.orbit.data;
  const weekOff   = state.orbit.weekOffset || 0;
  const selId     = state.orbit.selectedTaskId;
  const selected  = selId ? findTask(selId) : null;
  const { weekDays, weekLabel } = renderWeekGrid(data, weekOff, selId);
  const topTask   = _getTopTask();

  const completedToday = (() => {
    const today = (data.days || []).find(d => d.date === data.today);
    if (!today) return [0, 0];
    const study = today.tasks.filter(t => !isOrbitBreak(t) && t.taskType !== 'exam');
    return [study.filter(t => t.status === 'completed').length, study.length];
  })();

  container.innerHTML = `
    <div class="orbit-page orbit-calendar-page">
      <div class="page-hd orbit-hd">
        <div>
          <h1 class="page-title">Study Orbit</h1>
          <div class="page-sub">A live study calendar that reschedules unfinished work.</div>
        </div>
        <div class="orbit-actions">
          <button class="btn-secondary" data-action="jump-today">Today</button>
          <button class="btn-secondary" data-action="toggle-setup">${state.orbit.setupOpen ? 'Close preferences' : 'Preferences'}</button>
          <button class="btn-ghost" data-action="open-wizard" title="Re-run setup wizard">Setup</button>
          <button class="btn-primary" data-action="regenerate">Rebuild today</button>
        </div>
      </div>

      <div class="orbit-calendar-toolbar">
        <div class="orbit-week-switch">
          <button data-action="shift-week" data-delta="-1" aria-label="Previous week">‹</button>
          <strong>${escapeHtml(weekLabel)}</strong>
          <button data-action="shift-week" data-delta="1" aria-label="Next week">›</button>
        </div>
        <div class="orbit-view-toggle">
          <button class="active">Week</button>
          <button title="Month view coming soon">Month</button>
        </div>
        <div class="orbit-mini-status">${completedToday[0]}/${completedToday[1]} today · ${escapeHtml(data.preferences.dailyEffort)} effort</div>
      </div>

      ${state.orbit.setupOpen ? renderSetup(data) : ''}
      ${renderTopTask(topTask)}

      <div class="orbit-calendar-layout ${selected ? 'drawer-open' : ''}">
        <div class="orbit-week-grid">
          ${weekDays.map(day => renderCalendarDay(day, selId)).join('')}
        </div>
      </div>

      ${renderDrawer(selected)}
    </div>`;

  animateStaggerItems(container);
  mountChat(container);
}

// ── Event delegation ──────────────────────────────────────────────────────────

function _onClick(container, e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;

  const action = el.dataset.action;

  switch (action) {
    // Calendar navigation
    case 'shift-week': {
      const delta = parseInt(el.dataset.delta, 10);
      const max = Math.max(0, Math.ceil((state.orbit.data?.days?.length || 1) / 7) - 1);
      state.orbit.weekOffset = Math.max(0, Math.min(max, (state.orbit.weekOffset || 0) + delta));
      _renderInner(container);
      break;
    }
    case 'jump-today': {
      const idx = state.orbit.data?.days.findIndex(d => d.date === state.orbit.data.today) ?? 0;
      state.orbit.weekOffset = Math.max(0, Math.floor(idx / 7));
      _renderInner(container);
      break;
    }

    // Setup/wizard
    case 'toggle-setup':
      state.orbit.setupOpen = !state.orbit.setupOpen;
      _renderInner(container);
      break;
    case 'open-wizard':
      state.orbit.wizardOpen = true;
      state.orbit.wizardStep = 0;
      _renderInner(container);
      break;
    case 'regenerate':
      regenerateOrbit().then(() => _renderInner(container)).catch(() => {});
      break;

    // Task selection
    case 'select-task':
      state.orbit.selectedTaskId = el.dataset.taskId || null;
      _renderInner(container);
      break;
    case 'deselect-task':
      state.orbit.selectedTaskId = null;
      _renderInner(container);
      break;

    // Task actions (drawer)
    case 'toggle-task-status': {
      const { taskId, taskStatus } = el.dataset;
      setTaskStatus(taskId, taskStatus === 'completed' ? 'pending' : 'completed');
      break;
    }
    case 'skip-task':
      setTaskStatus(el.dataset.taskId, 'skipped');
      break;
    case 'shorten-task': {
      const task = findTask(el.dataset.taskId);
      if (!task) break;
      task.durationMinutes = Math.min(task.durationMinutes, 25);
      task.title = task.title + ' (short)';
      task.reasoning = 'Short fallback: do the smallest useful version now.';
      _renderInner(container);
      break;
    }
    case 'move-task-tomorrow': {
      const today = state.orbit.data?.today;
      if (!today) break;
      moveTaskToDate(el.dataset.taskId, addDaysKey(today, 1));
      break;
    }
    case 'move-task-next-slot': {
      const task = findTask(el.dataset.taskId);
      if (!task) break;
      const today = state.orbit.data?.today;
      moveTaskToDate(el.dataset.taskId, addDaysKey(today, 1));
      break;
    }
    case 'open-course':
      navigate('course-detail', { courseId: el.dataset.courseId });
      break;
    case 'quiz-task':
      window.openQuiz?.(el.dataset.courseId, el.dataset.sessionId || null);
      break;
    case 'tutor-task': {
      const task = findTask(el.dataset.taskId);
      if (!task) break;
      navigate('tutor');
      setTimeout(() => {
        const input = document.getElementById('chat-input');
        if (input) {
          input.value = _orbitTutorStarter(task);
          input.focus();
        }
        window.askTutorAbout?.(task.courseId);
      }, 80);
      break;
    }

    // Wizard actions
    case 'wizard-next': {
      const v = wizardValues();
      state.orbit.wizardValues = { ...v, techniques: Array.isArray(v.techniques) ? v.techniques : [...v.techniques] };
      state.orbit.wizardStep = (state.orbit.wizardStep || 0) + 1;
      _renderInner(container);
      break;
    }
    case 'wizard-back':
      state.orbit.wizardStep = Math.max(0, (state.orbit.wizardStep || 0) - 1);
      _renderInner(container);
      break;
    case 'wizard-go-step': {
      const v = wizardValues();
      state.orbit.wizardValues = { ...v, techniques: Array.isArray(v.techniques) ? v.techniques : [...v.techniques] };
      state.orbit.wizardStep = parseInt(el.dataset.step, 10);
      _renderInner(container);
      break;
    }
    case 'wizard-patch': {
      const v = wizardValues();
      const field = el.dataset.field;
      const value = el.dataset.value || el.value;
      state.orbit.wizardValues = { ...v, techniques: Array.isArray(v.techniques) ? v.techniques : [...v.techniques], [field]: value };
      if (field === 'dailyEffort') _renderInner(container); // re-render for button active states
      break;
    }
    case 'wizard-toggle-technique': {
      const v = wizardValues();
      const techs = new Set(Array.isArray(v.techniques) ? v.techniques : [...v.techniques]);
      const id = el.dataset.technique;
      if (techs.has(id)) { if (techs.size > 1) techs.delete(id); }
      else techs.add(id);
      state.orbit.wizardValues = { ...v, techniques: [...techs] };
      _renderInner(container);
      break;
    }
    case 'wizard-submit':
      _wizardSubmit(container);
      break;

    // Setup actions
    case 'toggle-technique': {
      const prefs = state.orbit.data?.preferences || {};
      const set   = new Set(prefs.preferredTechniques || []);
      const id    = el.dataset.technique;
      if (set.has(id)) set.delete(id); else set.add(id);
      saveOrbitPrefs({ preferredTechniques: [...set] });
      break;
    }
  }
}

function _onChange(container, e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;

  const action = el.dataset.action;

  switch (action) {
    case 'wizard-set-exam': {
      const v = wizardValues();
      const { courseId, field } = el.dataset;
      const ov = { ...(v.examOverrides || {}) };
      ov[courseId] = { ...(ov[courseId] || {}), [field]: el.value };
      state.orbit.wizardValues = { ...v, examOverrides: ov };
      break;
    }
    case 'wizard-patch': {
      const v = wizardValues();
      state.orbit.wizardValues = { ...v, [el.dataset.field]: el.value };
      break;
    }
    case 'save-pref':
      saveOrbitPrefs({ [el.dataset.field]: el.value });
      break;
    case 'save-day-time':
      saveOrbitDayTime(el.dataset.date, el.dataset.field, Math.round(Number(el.value) * 60));
      break;
    case 'save-rating':
      saveOrbitRating(el.dataset.courseId, el.dataset.sessionId, el.dataset.field, el.value);
      break;
  }
}

// ── Drag-and-drop ─────────────────────────────────────────────────────────────

function _onDragStart(e) {
  const card = e.target.closest('[data-drag-task-id]');
  if (!card) return;
  e.dataTransfer.setData('text/plain', card.dataset.dragTaskId);
  e.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
}

function _onDragEnd(e) {
  const card = e.target.closest('[data-drag-task-id]');
  if (card) card.classList.remove('dragging');
}

function _onDragOver(e) {
  const day = e.target.closest('[data-drop-date]');
  if (!day) return;
  e.preventDefault();
  day.classList.add('drag-over');
}

function _onDragLeave(e) {
  const day = e.target.closest('[data-drop-date]');
  if (day) day.classList.remove('drag-over');
}

function _onDrop(e) {
  const day = e.target.closest('[data-drop-date]');
  if (!day) return;
  e.preventDefault();
  day.classList.remove('drag-over');
  const taskId = e.dataTransfer.getData('text/plain');
  if (taskId) moveTaskToDate(taskId, day.dataset.dropDate);
}

// ── Wizard submit ─────────────────────────────────────────────────────────────

async function _wizardSubmit(container) {
  const v = wizardValues();
  state.orbit.wizardOpen  = false;
  state.orbit.wizardValues = null;
  _startGenerating(container);
  _renderInner(container);

  try {
    await mutateOrbit('/api/study/preferences', {
      wakeTime:           v.wakeTime,
      bedTime:            v.bedTime,
      dailyEffort:        v.dailyEffort,
      preferredTechniques: Array.isArray(v.techniques) ? v.techniques : [...v.techniques],
      examOverrides:      v.examOverrides || {},
      markSetupComplete:  true,
    });
    _stopGenerating();
    _renderInner(container);
  } catch (err) {
    _stopGenerating();
    showToast('Setup failed: ' + err.message, 'error');
    state.orbit.wizardOpen = true;
    _renderInner(container);
  }
}

// ── Mount / unmount ───────────────────────────────────────────────────────────

export function mount(container) {
  _renderInner(container);

  function onData()  { _renderInner(container); }
  function onError() { _renderInner(container); }

  on('orbit:data',  onData);
  on('orbit:error', onError);
  on('courses:loaded', onData);

  container.addEventListener('click',     e => _onClick(container, e));
  container.addEventListener('change',    e => _onChange(container, e));
  container.addEventListener('dragstart', _onDragStart);
  container.addEventListener('dragend',   _onDragEnd);
  container.addEventListener('dragover',  _onDragOver);
  container.addEventListener('dragleave', _onDragLeave);
  container.addEventListener('drop',      _onDrop);

  return function unmount() {
    off('orbit:data',    onData);
    off('orbit:error',   onError);
    off('courses:loaded', onData);
    _stopGenerating();
    unmountChat();
  };
}
