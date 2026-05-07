import { escapeHtml, daysUntil, effectiveExamDate } from '../../lib/utils.js';
import { ORBIT_RATING_FIELDS, ORBIT_RATINGS, ORBIT_TECHNIQUES } from '../../config.js';
import { state } from '../../store/store.js';

function _getOrbitRating(data, courseId, sessionId) {
  const found = (data.ratings || []).find(r => r.courseId === courseId && r.sessionId === sessionId);
  return found || { courseId, sessionId, slideLoad: 'medium', lectureDepth: 'medium', requiredDepth: 'medium', syllabusDifficulty: 'medium', effort: 'medium' };
}

function _ratingRow(courseId, sessionId, label, data, compact = false) {
  const rating = _getOrbitRating(data, courseId, sessionId);
  return `
    <div class="orbit-rating-row ${compact ? 'compact' : ''}">
      <span class="orbit-rating-name">${escapeHtml(label)}</span>
      ${ORBIT_RATING_FIELDS.map(f => `
        <select
          data-action="save-rating"
          data-course-id="${escapeHtml(courseId)}"
          data-session-id="${escapeHtml(sessionId)}"
          data-field="${escapeHtml(f.id)}"
          aria-label="${escapeHtml(f.label)}">
          ${ORBIT_RATINGS.map(r => `<option value="${r}" ${rating[f.id] === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      `).join('')}
    </div>`;
}

export function renderSetup(data) {
  const prefs = data.preferences;
  const techniques = new Set(prefs.preferredTechniques || []);

  const courseRows = Object.keys(state.courses)
    .sort((a, b) => daysUntil(effectiveExamDate(a)) - daysUntil(effectiveExamDate(b)))
    .map(courseId => _ratingRow(courseId, '__course__', state.courses[courseId].name, data))
    .join('');

  const lectureRows = Object.keys(state.courses).map(courseId => {
    const course = state.courses[courseId];
    const rows = (course.sessions || []).map(s =>
      _ratingRow(courseId, s.id, `L${s.id}: ${s.title}`, data, true)
    ).join('');
    return `
      <details class="orbit-rating-details">
        <summary>
          <span class="course-dot c-${escapeHtml(courseId)}"></span>
          ${escapeHtml(course.name)} lecture overrides
        </summary>
        <div class="orbit-rating-list">${rows}</div>
      </details>`;
  }).join('');

  return `
    <section class="orbit-setup stagger-item">
      <div class="orbit-setup-top">
        <div>
          <div class="section-label">Setup</div>
          <h2>Planner inputs</h2>
        </div>
        <button class="btn-ghost" data-action="toggle-setup">Done</button>
      </div>
      <div class="orbit-pref-grid">
        <label>Wake
          <input type="time" value="${escapeHtml(prefs.wakeTime)}"
            data-action="save-pref" data-field="wakeTime">
        </label>
        <label>Bed
          <input type="time" value="${escapeHtml(prefs.bedTime)}"
            data-action="save-pref" data-field="bedTime">
        </label>
        <label>Daily effort
          <select data-action="save-pref" data-field="dailyEffort">
            ${ORBIT_RATINGS.map(r => `<option value="${r}" ${prefs.dailyEffort === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="orbit-setup-note">Difficulty is inferred from slide load, topic complexity, quiz weakness, and exam pressure. Only override if something feels clearly wrong.</div>
      <div class="orbit-techniques">
        ${ORBIT_TECHNIQUES.map(t => `
          <button class="${techniques.has(t.id) ? 'active' : ''}"
            data-action="toggle-technique"
            data-technique="${escapeHtml(t.id)}">${escapeHtml(t.label)}</button>
        `).join('')}
      </div>
      <div class="orbit-rating-grid">
        <div class="orbit-rating-head">
          <span>Course defaults</span>
          ${ORBIT_RATING_FIELDS.map(f => `<span>${escapeHtml(f.label)}</span>`).join('')}
        </div>
        ${courseRows}
      </div>
      <div class="orbit-lecture-setup">${lectureRows}</div>
    </section>`;
}
