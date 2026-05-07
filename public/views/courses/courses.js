import { state, on, off } from '../../store/store.js';
import { navigate } from '../../router.js';
import { escapeHtml, daysUntil, effectiveExamDate, getCoverage } from '../../lib/utils.js';
import { animateStaggerItems, animateProgressBars } from '../../lib/utils.js';

function _render(container) {
  if (!state.courses) {
    container.innerHTML = `<div class="page-hd"><h1 class="page-title">Courses</h1></div>
      <div class="bento">${[0,1,2,3,4].map(() => `<div class="skeleton col-6" style="height:120px;border-radius:1rem;"></div>`).join('')}</div>`;
    return;
  }

  const cards = Object.keys(state.courses)
    .sort((a, b) => daysUntil(effectiveExamDate(a)) - daysUntil(effectiveExamDate(b)))
    .map(id => {
      const course = state.courses[id];
      const days = daysUntil(effectiveExamDate(id));
      const cov  = getCoverage(id);
      return `
        <div class="bento-card col-6 stagger-item c-${id}" data-action="open-course" data-course="${id}" style="cursor:pointer;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem;margin-bottom:0.875rem;">
            <div>
              <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.375rem;">
                <div class="course-dot"></div>
                <div style="font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--t3);">${days} days</div>
              </div>
              <div style="font-weight:700;font-size:1rem;color:var(--t1);letter-spacing:-0.02em;">${escapeHtml(course.name)}</div>
              <div style="font-size:0.8125rem;color:var(--t3);margin-top:0.25rem;">${escapeHtml(course.exam_format || '')}</div>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--t3);margin-bottom:0.375rem;">
            <span>${course.sessions.length} sessions</span>
            <span style="font-family:'Geist Mono',monospace;">${cov}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill c-${id}" style="width:${cov}%;"></div>
          </div>
        </div>`;
    }).join('');

  container.innerHTML = `
    <div class="page-hd"><h1 class="page-title">Courses</h1></div>
    <div class="bento">${cards}</div>`;

  requestAnimationFrame(() => {
    animateStaggerItems(container);
    animateProgressBars(container);
  });
}

export function mount(container) {
  _render(container);

  function onData() { _render(container); }
  on('courses:loaded', onData);

  function onClick(e) {
    const el = e.target.closest('[data-action="open-course"]');
    if (el) navigate('course-detail', { courseId: el.dataset.course });
  }
  container.addEventListener('click', onClick);

  return function unmount() {
    off('courses:loaded', onData);
    container.removeEventListener('click', onClick);
  };
}
