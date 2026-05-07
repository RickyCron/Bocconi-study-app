import { escapeHtml } from '../../lib/utils.js';
import { WIZARD_TECHNIQUES, EXAM_DATES } from '../../config.js';
import { state } from '../../store/store.js';

const STEPS = ['Welcome', 'Exam dates', 'Daily schedule', 'Study style'];

export function wizardValues() {
  const raw = state.orbit.wizardValues || {};
  return {
    wakeTime:      raw.wakeTime      || state.orbit.data?.preferences?.wakeTime      || '08:30',
    bedTime:       raw.bedTime       || state.orbit.data?.preferences?.bedTime       || '23:30',
    dailyEffort:   raw.dailyEffort   || state.orbit.data?.preferences?.dailyEffort   || 'medium',
    techniques:    raw.techniques    || state.orbit.data?.preferences?.preferredTechniques || ['notes','update','deeper','quiz'],
    examOverrides: raw.examOverrides || state.orbit.data?.preferences?.examOverrides || {},
  };
}

export function renderWizard() {
  const step = state.orbit.wizardStep || 0;
  const v = wizardValues();
  const techSet = new Set(v.techniques);

  const dots = STEPS.map((label, i) => `
    <button class="wizard-dot ${i === step ? 'active' : i < step ? 'done' : ''}"
      data-action="wizard-go-step" data-step="${i}"
      title="${escapeHtml(label)}" aria-label="${escapeHtml(label)} step"></button>
  `).join('');

  let body = '';

  if (step === 0) {
    body = `
      <div class="wizard-welcome">
        <div class="wizard-icon">🛰️</div>
        <h2>Welcome to Study Orbit</h2>
        <p>Orbit builds a live timetable that adjusts every day — scheduling lectures in the right order, ramping up pressure as exams approach, and rescheduling anything you miss automatically.</p>
        <p>Take 60 seconds to set your preferences and we'll generate your first plan.</p>
        <button class="btn-primary wizard-next-btn" data-action="wizard-next">Let's set it up →</button>
      </div>`;

  } else if (step === 1) {
    const rows = Object.entries(EXAM_DATES).map(([id, fallbackDate]) => {
      const course = state.courses?.[id];
      const name   = course?.name || id;
      const ov     = v.examOverrides[id] || {};
      const dateVal  = ov.date || fallbackDate.toISOString().slice(0, 10);
      const parsedTime = (() => {
        const m = (course?.exam_date || '').match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
        if (!m) return '';
        let h = +m[1];
        if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
        if (m[3].toLowerCase() === 'am' && h === 12)  h = 0;
        return `${String(h).padStart(2,'0')}:${m[2]}`;
      })();
      const startVal = ov.time    || parsedTime;
      const endVal   = ov.endTime || '';
      return `
        <div class="wizard-exam-row">
          <span class="course-dot c-${escapeHtml(id)}"></span>
          <div class="wizard-exam-info"><strong>${escapeHtml(name)}</strong></div>
          <div class="wizard-exam-inputs">
            <input type="date" value="${escapeHtml(dateVal)}"
              data-action="wizard-set-exam" data-course-id="${escapeHtml(id)}" data-field="date"
              title="Exam date">
            <input type="time" value="${escapeHtml(startVal)}" placeholder="Start"
              data-action="wizard-set-exam" data-course-id="${escapeHtml(id)}" data-field="time"
              title="Start time">
            <span class="wizard-exam-sep">→</span>
            <input type="time" value="${escapeHtml(endVal)}" placeholder="End"
              data-action="wizard-set-exam" data-course-id="${escapeHtml(id)}" data-field="endTime"
              title="End time">
          </div>
        </div>`;
    }).join('');

    body = `
      <h2>Your exam schedule</h2>
      <p>Set the date, start, and end time for each exam. Orbit blocks off this slot and schedules a rest period before it.</p>
      <div class="wizard-exam-list">${rows}</div>
      <p class="wizard-note">Leave times blank if unknown — update later via Preferences.</p>`;

  } else if (step === 2) {
    body = `
      <h2>Daily schedule</h2>
      <p>When do you usually wake up and go to bed? Orbit schedules within your available hours.</p>
      <div class="wizard-fields">
        <label class="wizard-field">
          <span>Wake up</span>
          <input type="time" value="${escapeHtml(v.wakeTime)}"
            data-action="wizard-patch" data-field="wakeTime">
        </label>
        <label class="wizard-field">
          <span>Bed time</span>
          <input type="time" value="${escapeHtml(v.bedTime)}"
            data-action="wizard-patch" data-field="bedTime">
        </label>
      </div>
      <div class="wizard-effort-group">
        <span>Daily study effort</span>
        <div class="wizard-effort-btns">
          ${['low','medium','high'].map(e => `
            <button class="wizard-effort-btn ${v.dailyEffort === e ? 'active' : ''}"
              data-action="wizard-patch" data-field="dailyEffort" data-value="${e}">
              ${e === 'low' ? '🌱 Light' : e === 'medium' ? '⚡ Moderate' : '🔥 Intensive'}
            </button>`).join('')}
        </div>
      </div>`;

  } else if (step === 3) {
    const chips = WIZARD_TECHNIQUES.map(t => `
      <button class="wizard-technique ${techSet.has(t.id) ? 'active' : ''}"
        data-action="wizard-toggle-technique" data-technique="${escapeHtml(t.id)}">
        <strong>${escapeHtml(t.label)}</strong>
        <small>${escapeHtml(t.desc)}</small>
      </button>`).join('');

    body = `
      <h2>How do you like to study?</h2>
      <p>Pick the methods that work for you. Orbit prioritises these when building daily blocks.</p>
      <div class="wizard-techniques">${chips}</div>`;
  }

  const isLast = step === STEPS.length - 1;
  const navBtns = step === 0 ? '' : `
    <div class="wizard-nav">
      <button class="btn-ghost" data-action="wizard-back">← Back</button>
      ${isLast
        ? `<button class="btn-primary" data-action="wizard-submit">Generate my plan</button>`
        : `<button class="btn-primary" data-action="wizard-next">Next →</button>`
      }
    </div>`;

  return `
    <div class="orbit-wizard">
      <div class="wizard-card">
        <div class="wizard-steps">${dots}</div>
        <div class="wizard-body">${body}</div>
        ${navBtns}
      </div>
    </div>`;
}
