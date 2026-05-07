import { state } from '../../store/store.js';
import { navigate } from '../../router.js';
import { saveProgress } from '../../lib/api.js';
import {
  escapeHtml, daysUntil, effectiveExamDate,
  getCoverage, getWrongCount, animateStaggerItems, animateProgressBars,
} from '../../lib/utils.js';

let _courseId = null;

// ── Slide upload modal (self-contained, appended to body) ─────────────────────

function openSlideUpload(courseId, sessionId = null) {
  const course = state.courses?.[courseId];
  if (!course) return;

  const sessionOptions = course.sessions.map(s => `
    <option value="${s.id}" ${s.id === sessionId ? 'selected' : ''}>Lecture ${escapeHtml(s.id)} — ${escapeHtml(s.title)}</option>`).join('');

  const inputStyle = 'font-size:0.8125rem;padding:0.5rem 0.625rem;border:1px solid var(--border);border-radius:0.375rem;background:var(--bg);color:var(--t1);';
  const segStyle = (active) => `font-size:0.75rem;padding:0.3rem 0.625rem;border-radius:0.25rem;border:0;cursor:pointer;font-weight:${active ? '600' : '400'};background:${active ? 'var(--t1)' : 'transparent'};color:${active ? 'var(--surface)' : 'var(--t3)'};`;

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:1000;';
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:0.75rem;padding:1.5rem;max-width:420px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.15);">
      <div style="font-size:1rem;font-weight:700;letter-spacing:-0.02em;margin-bottom:0.25rem;">Add slide deck</div>
      <div style="font-size:0.8125rem;color:var(--t3);margin-bottom:1rem;">${escapeHtml(course.name)}</div>
      <form id="slide-upload-form" style="display:flex;flex-direction:column;gap:0.75rem;">
        <label style="display:flex;flex-direction:column;gap:0.25rem;font-size:0.75rem;color:var(--t3);">
          File
          <input type="file" name="file" accept="application/pdf" required style="${inputStyle}padding:0.5rem;"/>
        </label>
        <label style="display:flex;flex-direction:column;gap:0.25rem;font-size:0.75rem;color:var(--t3);">
          Slide deck title
          <input type="text" name="title" placeholder="auto from filename" maxlength="120" style="${inputStyle}"/>
        </label>
        <div style="display:flex;flex-direction:column;gap:0.25rem;font-size:0.75rem;color:var(--t3);">
          Session
          <div style="display:flex;gap:0.25rem;padding:0.25rem;background:var(--bg);border:1px solid var(--border);border-radius:0.375rem;width:fit-content;">
            <button type="button" id="session-mode-existing" style="${segStyle(true)}">Link existing</button>
            <button type="button" id="session-mode-new" style="${segStyle(false)}">Create new</button>
          </div>
          <div id="session-existing-panel">
            <select name="session_ext_id" style="${inputStyle}width:100%;box-sizing:border-box;">
              <option value="" ${!sessionId ? 'selected' : ''}>Unlinked (extras)</option>
              ${sessionOptions}
            </select>
          </div>
          <div id="session-new-panel" style="display:none;">
            <input type="text" name="new_session_title" placeholder="e.g. International Trade Theory" maxlength="120" style="${inputStyle}width:100%;box-sizing:border-box;"/>
          </div>
        </div>
        <div id="slide-upload-status" style="font-size:0.75rem;color:var(--t3);min-height:1em;"></div>
        <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.25rem;">
          <button type="button" id="slide-upload-cancel"
            style="font-size:0.8125rem;padding:0.5rem 0.875rem;border-radius:0.375rem;border:1px solid var(--border);background:transparent;color:var(--t2);cursor:pointer;">Cancel</button>
          <button type="submit"
            style="font-size:0.8125rem;padding:0.5rem 0.875rem;border-radius:0.375rem;border:0;background:var(--t1);color:var(--surface);cursor:pointer;font-weight:600;">Upload</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelector('#slide-upload-cancel').addEventListener('click', close);

  const form            = modal.querySelector('#slide-upload-form');
  const status          = modal.querySelector('#slide-upload-status');
  const submit          = form.querySelector('[type="submit"]');
  const btnExisting     = modal.querySelector('#session-mode-existing');
  const btnNew          = modal.querySelector('#session-mode-new');
  const panelExisting   = modal.querySelector('#session-existing-panel');
  const panelNew        = modal.querySelector('#session-new-panel');
  const selectSession   = form.querySelector('[name="session_ext_id"]');
  const inputNewSession = form.querySelector('[name="new_session_title"]');

  const segActive   = 'font-size:0.75rem;padding:0.3rem 0.625rem;border-radius:0.25rem;border:0;cursor:pointer;font-weight:600;background:var(--t1);color:var(--surface);';
  const segInactive = 'font-size:0.75rem;padding:0.3rem 0.625rem;border-radius:0.25rem;border:0;cursor:pointer;font-weight:400;background:transparent;color:var(--t3);';

  let sessionMode = 'existing';
  btnExisting.addEventListener('click', () => {
    sessionMode = 'existing';
    btnExisting.style.cssText = segActive;
    btnNew.style.cssText = segInactive;
    panelExisting.style.display = '';
    panelNew.style.display = 'none';
    selectSession.disabled = false;
    inputNewSession.disabled = true;
  });
  btnNew.addEventListener('click', () => {
    sessionMode = 'new';
    btnNew.style.cssText = segActive;
    btnExisting.style.cssText = segInactive;
    panelNew.style.display = '';
    panelExisting.style.display = 'none';
    selectSession.disabled = true;
    inputNewSession.disabled = false;
    inputNewSession.focus();
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd   = new FormData(form);
    const file = fd.get('file');
    if (!file || !file.size) { status.textContent = 'Choose a PDF.'; return; }
    if (file.size > 45 * 1024 * 1024) { status.textContent = 'PDF too large (max 45 MB).'; return; }
    if (sessionMode === 'new') {
      const title = inputNewSession.value.trim();
      if (!title) { status.textContent = 'Enter a session title.'; inputNewSession.focus(); return; }
      fd.set('new_session_title', title);
      fd.delete('session_ext_id');
    } else {
      fd.delete('new_session_title');
    }
    submit.disabled = true; submit.textContent = 'Uploading…';
    status.textContent = '';
    try {
      const r    = await fetch(`/api/courses/${courseId}/slides`, { method: 'POST', body: fd });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Upload failed');
      close();
      const fresh = await fetch('/api/courses').then(r => r.json());
      state.courses = fresh.courses;
      _render(document.querySelector('#view-course-detail [data-view-content]'), courseId);
    } catch (err) {
      status.textContent = err.message;
      submit.disabled = false; submit.textContent = 'Upload';
    }
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

function _sessionHtml(courseId, s) {
  const sp    = state.progress[courseId]?.[s.id] || {};
  const done  = !!sp.notesDone;
  const score = sp.quizScore;
  const scoreColor = score >= 70 ? 'var(--green)' : score >= 50 ? 'var(--c-gtm)' : 'var(--red)';
  const slides = s.slides || [];

  const slideLink = sl => (sl.file && /^https?:\/\//.test(sl.file))
    ? sl.file
    : '/slides/' + sl.file.split('/').map(encodeURIComponent).join('/');

  const slidesRows = slides.map(sl => `
    <a href="${escapeHtml(slideLink(sl))}" target="_blank" rel="noopener"
       style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0.5rem;border-radius:0.375rem;font-size:0.8125rem;color:var(--t2);text-decoration:none;"
       onmouseover="this.style.background='var(--bg)'" onmouseout="this.style.background='transparent'">
      <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="flex-shrink:0;opacity:0.5;"><path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
      ${escapeHtml(sl.title)}
    </a>`).join('');

  const emptyRow = slides.length ? '' : `<div style="padding:0.4rem 0.5rem;font-size:0.75rem;color:var(--t3);">No slide decks yet.</div>`;
  const addRow = `
    <button data-action="add-slides" data-course="${courseId}" data-session="${s.id}"
      style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0.5rem;margin-top:0.25rem;border-radius:0.375rem;font-size:0.8125rem;color:var(--t2);background:transparent;border:1px dashed var(--border);width:100%;cursor:pointer;"
      onmouseover="this.style.background='var(--bg)';this.style.color='var(--t1)'" onmouseout="this.style.background='transparent';this.style.color='var(--t2)'">
      <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="flex-shrink:0;opacity:0.6;"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
      Add slide deck
    </button>`;

  return `
    <div class="session-card stagger-item">
      <div class="session-header">
        <div style="flex:1;min-width:0;">
          <div class="session-title">${escapeHtml(s.title)}</div>
          <div class="session-meta">
            <span>Lecture ${escapeHtml(s.id)}</span>
            <span>${s.topics.slice(0, 2).map(t => escapeHtml(t)).join(' · ')}</span>
          </div>
          <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap;">
            ${done ? `<span class="badge badge-green">Notes done</span>` : ''}
            ${score !== undefined ? `<span style="font-size:0.75rem;color:var(--t3);">Quiz <span style="font-family:'Geist Mono',monospace;font-weight:600;color:${scoreColor};">${score}%</span></span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:0.25rem;flex-shrink:0;">
          <button class="btn-icon" title="Listen" data-action="listen" data-course="${courseId}" data-session="${s.id}">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/></svg>
          </button>
          <button class="btn-icon" id="slides-btn-${courseId}-${s.id}" title="Slides" data-action="toggle-slides" data-course="${courseId}" data-session="${s.id}">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          </button>
          <button class="btn-icon" title="Quiz" data-action="quiz-session" data-course="${courseId}" data-session="${s.id}">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>
          </button>
          <button class="btn-icon" title="${done ? 'Mark undone' : 'Mark done'}" style="color:${done ? 'var(--green)' : 'var(--t3)'};"
            data-action="toggle-done" data-course="${courseId}" data-session="${s.id}">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </button>
        </div>
      </div>
      <div class="slides-dropdown" id="slides-${courseId}-${s.id}" style="display:none;margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border);">
        ${slidesRows}${emptyRow}${addRow}
      </div>
    </div>`;
}

function _render(container, courseId) {
  if (!state.courses || !courseId) return;
  const course = state.courses[courseId];
  if (!course) return;

  const days  = daysUntil(effectiveExamDate(courseId));
  const cov   = getCoverage(courseId);
  const wrong = getWrongCount(courseId);
  const sessions = course.sessions.map(s => _sessionHtml(courseId, s)).join('');

  container.innerHTML = `
    <div style="max-width:860px;">
      <button class="back-btn" data-action="back">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
        Back to courses
      </button>
      <div class="card c-${courseId}" style="margin-bottom:1.5rem;position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--cc),transparent);"></div>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:1.25rem;">
          <div>
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
              <div class="course-dot"></div>
              <div style="font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--t3);">${escapeHtml(course.exam_date || '')}</div>
            </div>
            <h1 style="font-size:1.5rem;font-weight:700;letter-spacing:-0.03em;margin:0;">${escapeHtml(course.name)}</h1>
            <div style="font-size:0.8125rem;color:var(--t3);margin-top:0.375rem;">${escapeHtml(course.exam_format || '')}</div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div class="day-num" style="color:var(--cc);">${days}</div>
            <div style="font-size:0.6875rem;color:var(--t3);text-transform:uppercase;letter-spacing:0.08em;margin-top:0.2rem;">days left</div>
          </div>
        </div>
        <div style="margin-bottom:1.25rem;">
          <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--t3);margin-bottom:0.375rem;">
            <span>Coverage</span><span style="font-family:'Geist Mono',monospace;">${cov}%</span>
          </div>
          <div class="progress-bar" style="height:4px;">
            <div class="progress-fill c-${courseId}" style="width:${cov}%;"></div>
          </div>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
          <button class="btn-primary" data-action="quiz-course" data-course="${courseId}">Quiz all lectures</button>
          ${wrong > 0 ? `<button class="btn-secondary" style="color:var(--red);border-color:oklch(0.45 0.18 15 / 0.35);"
            data-action="weak-drill" data-course="${courseId}">Drill ${wrong} weak point${wrong !== 1 ? 's' : ''}</button>` : ''}
          <button class="btn-secondary" data-action="listen-course" data-course="${courseId}">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="display:inline;vertical-align:-2px;margin-right:4px;"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/></svg>
            Course overview
          </button>
          <button class="btn-secondary" data-action="ask-tutor" data-course="${courseId}">Ask tutor</button>
          <button class="btn-secondary" data-action="add-slides" data-course="${courseId}">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="display:inline;vertical-align:-2px;margin-right:4px;"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
            Add slide deck
          </button>
        </div>
      </div>
      <div class="section-label" style="margin-bottom:0.75rem;">Lectures</div>
      <div class="session-list">${sessions}</div>
    </div>`;

  requestAnimationFrame(() => {
    animateStaggerItems(container);
    animateProgressBars(container);
  });
}

// ── Mount / unmount ───────────────────────────────────────────────────────────

export function mount(container, params = {}) {
  _courseId = params.courseId || null;
  _render(container, _courseId);

  function onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action    = btn.dataset.action;
    const courseId  = btn.dataset.course || _courseId;
    const sessionId = btn.dataset.session || null;

    if (action === 'back')          navigate('courses');
    else if (action === 'quiz-course')   window.openQuiz?.(courseId);
    else if (action === 'quiz-session')  window.openQuiz?.(courseId, sessionId);
    else if (action === 'weak-drill')    window.openWeakDrill?.(courseId);
    else if (action === 'listen')        window.openListen?.(courseId, sessionId);
    else if (action === 'listen-course') window.openListen?.(courseId, null);
    else if (action === 'ask-tutor')     window.askTutorAbout?.(courseId);
    else if (action === 'add-slides')    openSlideUpload(courseId, sessionId);
    else if (action === 'toggle-slides') {
      const el  = container.querySelector(`#slides-${courseId}-${sessionId}`);
      const bEl = container.querySelector(`#slides-btn-${courseId}-${sessionId}`);
      if (!el) return;
      const open = el.style.display === 'none';
      el.style.display = open ? 'block' : 'none';
      if (bEl) bEl.style.color = open ? 'var(--cc)' : '';
    }
    else if (action === 'toggle-done') {
      if (!state.progress[courseId]) state.progress[courseId] = {};
      if (!state.progress[courseId][sessionId]) state.progress[courseId][sessionId] = {};
      state.progress[courseId][sessionId].notesDone = !state.progress[courseId][sessionId].notesDone;
      saveProgress();
      _render(container, courseId);
    }
  }
  container.addEventListener('click', onClick);

  return function unmount() {
    container.removeEventListener('click', onClick);
    _courseId = null;
  };
}
