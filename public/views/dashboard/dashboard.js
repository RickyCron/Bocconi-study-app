import { state, on, off } from '../../store/store.js';
import { navigate } from '../../router.js';
import {
  escapeHtml, daysUntil, effectiveExamDate,
  getCoverage, getAvgScore, getWrongCount,
  urgencyScore, urgencyColor, shuffle,
} from '../../lib/utils.js';
import { COURSE_MAP } from '../../config.js';

// ── Carousel state (module-scoped, reset on each mount) ───────────────────────

let _c = {};

function _carouselBase(idx) {
  const track = _c.track;
  if (!track) return 0;
  return (track.parentElement.offsetWidth - _c.cardW) / 2 - idx * (_c.cardW + 12);
}

function _setOffset(idx, animate) {
  if (!_c.track) return;
  _c.idx = Math.max(0, Math.min(idx, _c.count - 1));
  if (animate) {
    _c.track.classList.remove('is-dragging');
    _c.track.classList.add('is-snapping');
    setTimeout(() => _c.track?.classList.remove('is-snapping'), 400);
  }
  _c.track.style.transform = `translateX(${_carouselBase(_c.idx)}px)`;
  _c.track.querySelectorAll('.carousel-card').forEach((card, i) => card.classList.toggle('is-active', i === _c.idx));
  _c.container.querySelectorAll('.carousel-dot').forEach((dot, i) => dot.classList.toggle('is-active', i === _c.idx));
}

function _down(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  _c.dragging = true; _c.startX = e.clientX; _c.dragX = 0; _c.velX = 0;
  _c.lastX = e.clientX; _c.lastT = Date.now();
  e.currentTarget.classList.add('is-dragging');
}

function _move(e) {
  if (!_c.dragging) return;
  const dt = Date.now() - _c.lastT || 1;
  _c.velX = (e.clientX - _c.lastX) / dt;
  _c.lastX = e.clientX; _c.lastT = Date.now();
  _c.dragX = e.clientX - _c.startX;
  e.currentTarget.style.transform = `translateX(${_carouselBase(_c.idx) + _c.dragX}px)`;
}

function _up(e) {
  if (!_c.dragging) return;
  _c.dragging = false;
  e.currentTarget.classList.remove('is-dragging');
  const v = _c.velX, d = _c.dragX, threshold = _c.cardW * 0.18;
  let next = _c.idx;
  if (v < -0.15 || (Math.abs(v) <= 0.15 && d < -threshold)) next = Math.min(_c.idx + 1, _c.count - 1);
  else if (v > 0.15 || (Math.abs(v) <= 0.15 && d > threshold)) next = Math.max(_c.idx - 1, 0);
  _setOffset(next, true);
}

function _click(e) {
  if (Math.abs(_c.dragX) > 8) { e.stopPropagation(); e.preventDefault(); }
  _c.dragX = 0;
}

function _wheel(e) {
  const ax = Math.abs(e.deltaX), ay = Math.abs(e.deltaY);
  if (ax < 2 || ay > ax * 3) return;
  e.preventDefault();
  clearTimeout(_c.wheelTimer);
  _c.wheelTimer = setTimeout(() => { _c.wheelLocked = false; _c.wheelAccum = 0; }, 350);
  if (_c.wheelLocked) return;
  _c.wheelAccum += e.deltaX;
  if (_c.wheelAccum > 25) { _c.wheelLocked = true; _c.wheelAccum = 0; _setOffset(_c.idx + 1, true); }
  else if (_c.wheelAccum < -25) { _c.wheelLocked = true; _c.wheelAccum = 0; _setOffset(_c.idx - 1, true); }
}

function _initCarousel(container, count) {
  const track = container.querySelector('#carousel-track');
  if (!track) return;
  const card = track.querySelector('.carousel-card');
  _c = {
    track, container, count,
    idx: 0, cardW: card ? card.offsetWidth : Math.min(track.parentElement.offsetWidth * 0.88, 520),
    dragging: false, startX: 0, dragX: 0, velX: 0, lastX: 0, lastT: 0,
    wheelAccum: 0, wheelLocked: false, wheelTimer: null,
  };
  _setOffset(0, false);
  track.addEventListener('pointerdown', _down);
  track.addEventListener('pointermove', _move);
  track.addEventListener('pointerup', _up);
  track.addEventListener('pointercancel', _up);
  track.addEventListener('click', _click, true);
  track.parentElement.addEventListener('wheel', _wheel, { passive: false });
}

function _destroyCarousel() {
  const track = _c.track;
  if (!track) return;
  track.removeEventListener('pointerdown', _down);
  track.removeEventListener('pointermove', _move);
  track.removeEventListener('pointerup', _up);
  track.removeEventListener('pointercancel', _up);
  track.removeEventListener('click', _click, true);
  track.parentElement?.removeEventListener('wheel', _wheel);
  clearTimeout(_c.wheelTimer);
  _c = {};
}

// ── Render helpers ────────────────────────────────────────────────────────────

function _cardHtml(id, i) {
  const course = state.courses[id];
  const days  = daysUntil(effectiveExamDate(id));
  const cov   = getCoverage(id);
  const score = getAvgScore(id);
  const u     = urgencyScore(id);
  const next  = course.sessions.find(s => !state.progress[id]?.[s.id]?.notesDone);
  const [badgeText, badgeClass] = u > 0.01
    ? ['Study now', 'badge-red']
    : u > 0.004
    ? ['Review', 'badge-amber']
    : ['On track', 'badge-green'];

  return `
    <div class="carousel-card c-${id}${i === 0 ? ' is-active' : ''}" data-idx="${i}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <div class="course-dot"></div>
          <span style="font-size:0.6875rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--t3);">${escapeHtml(course.name)}</span>
        </div>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      <div style="margin-bottom:1.5rem;">
        <div style="font-family:'Geist Mono',monospace;font-size:3rem;font-weight:700;line-height:1;letter-spacing:-0.04em;color:${urgencyColor(u)};">${days}</div>
        <div style="font-size:0.6875rem;color:var(--t3);text-transform:uppercase;letter-spacing:0.08em;margin-top:0.25rem;">days to exam · ${effectiveExamDate(id).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</div>
      </div>
      <div style="margin-bottom:0.875rem;">
        <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--t3);margin-bottom:0.375rem;">
          <span>Coverage</span><span style="font-family:'Geist Mono',monospace;">${cov}%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill c-${id}" style="width:${cov}%;"></div></div>
      </div>
      <div style="font-size:0.8125rem;color:var(--t3);margin-bottom:0.25rem;">
        Quiz avg <span style="font-family:'Geist Mono',monospace;color:var(--t2);font-weight:600;">${score !== null ? score + '%' : '—'}</span>
      </div>
      <div style="font-size:0.8125rem;color:var(--t3);margin-bottom:1.375rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        Next: <span style="color:var(--t2);">${next ? escapeHtml(next.title) : 'All sessions covered'}</span>
      </div>
      <div style="display:flex;gap:0.5rem;">
        <button class="btn-primary" style="font-size:0.8125rem;padding:0.45rem 1rem;"
          data-action="open-course" data-course="${id}">Open course</button>
        <button class="btn-secondary" style="font-size:0.8125rem;padding:0.45rem 0.875rem;"
          data-action="quick-quiz" data-course="${id}">Quick quiz</button>
      </div>
    </div>`;
}

function _render(container) {
  _destroyCarousel();

  if (!state.courses) {
    container.innerHTML = `
      <div class="page-hd"><div class="skeleton" style="width:140px;height:2rem;"></div></div>
      <div class="carousel-wrap">
        <div style="display:flex;gap:0.75rem;padding:0.5rem 1.5rem;">
          ${[0,1,2].map(() => `<div class="skeleton" style="flex-shrink:0;width:min(82vw,400px);height:280px;border-radius:1.25rem;"></div>`).join('')}
        </div>
      </div>`;
    return;
  }

  const sorted = Object.keys(state.courses).sort((a, b) => urgencyScore(b) - urgencyScore(a));
  const byExam  = [...sorted].sort((a, b) => daysUntil(effectiveExamDate(a)) - daysUntil(effectiveExamDate(b)));
  const totalWrong = getWrongCount();

  const drillHtml = totalWrong > 0 ? `
    <div class="drill-banner stagger-item" data-action="weak-drill">
      <div style="display:flex;align-items:center;gap:0.75rem;">
        <div class="drill-count-pill">${totalWrong}</div>
        <div>
          <div style="font-size:0.875rem;font-weight:600;color:var(--t1);">Weak points to review</div>
          <div style="font-size:0.75rem;color:var(--t3);margin-top:0.125rem;">Questions you've missed across all courses</div>
        </div>
      </div>
      <svg width="16" height="16" fill="none" viewBox="0 0 16 16" style="flex-shrink:0;color:var(--t3);"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>` : '';

  const timelineHtml = byExam.map(id => {
    const cov = getCoverage(id);
    return `
      <div class="exam-chip c-${id}" data-action="open-course" data-course="${id}">
        <div style="display:flex;align-items:center;gap:0.375rem;margin-bottom:0.375rem;">
          <div class="course-dot" style="width:5px;height:5px;"></div>
          <span style="font-size:0.6875rem;font-weight:700;color:var(--t2);">${escapeHtml(COURSE_MAP[id]?.name || id)}</span>
        </div>
        <div style="font-size:0.6875rem;color:var(--t3);margin-bottom:0.5rem;">${effectiveExamDate(id).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</div>
        <div class="progress-bar" style="height:2px;margin:0;">
          <div class="progress-fill c-${id}" style="width:${cov}%;"></div>
        </div>
      </div>`;
  }).join('');

  const cardsHtml = sorted.map((id, i) => _cardHtml(id, i)).join('');
  const dotsHtml  = sorted.map((_, i) => `<div class="carousel-dot${i === 0 ? ' is-active' : ''}"></div>`).join('');

  container.innerHTML = `
    <div class="page-hd" style="margin-bottom:1.5rem;">
      <h1 class="page-title">Today</h1>
      <div class="page-sub">${new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})}</div>
    </div>
    ${drillHtml}
    <div class="section-label" style="padding-left:1.5rem;margin-bottom:0.75rem;">Focus order</div>
    <div class="carousel-wrap">
      <div class="carousel-track" id="carousel-track">${cardsHtml}</div>
    </div>
    <div class="carousel-dots" id="carousel-dots">${dotsHtml}</div>
    <div class="section-label" style="margin-top:2rem;margin-bottom:0.875rem;">All exams</div>
    <div class="exam-timeline">${timelineHtml}</div>`;

  requestAnimationFrame(() => {
    // Animate progress bars
    container.querySelectorAll('.progress-fill:not(.animated)').forEach((el, i) => {
      const target = el.style.width || '0%';
      el.style.width = '0%';
      el.style.setProperty('--progress-target', target);
      setTimeout(() => el.classList.add('animated'), i * 80 + 100);
    });
    _initCarousel(container, sorted.length);
  });
}

// ── Mount / unmount ───────────────────────────────────────────────────────────

export function mount(container) {
  _render(container);

  // Re-render when course data arrives
  function onData() { _render(container); }
  on('courses:loaded', onData);

  // Event delegation for all clickable elements
  function onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const courseId = btn.dataset.course;
    if (action === 'open-course')  navigate('course-detail', { courseId });
    else if (action === 'quick-quiz') window.openQuiz?.(courseId);
    else if (action === 'weak-drill') window.openWeakDrill?.();
  }
  container.addEventListener('click', onClick);

  return function unmount() {
    off('courses:loaded', onData);
    container.removeEventListener('click', onClick);
    _destroyCarousel();
  };
}
