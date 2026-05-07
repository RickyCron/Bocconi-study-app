import { escapeHtml, formatOrbitDate, stageLabel, daysUntil, effectiveExamDate, isOrbitBreak } from '../../lib/utils.js';
import { state } from '../../store/store.js';
import { renderCard } from './orbit-card.js';

export function renderTopTask(task) {
  if (!task) {
    return `
      <section class="orbit-now-strip">
        <div>
          <span>Task at hand</span>
          <strong>No pending study block</strong>
          <small>Your core backlog is clear for the visible plan.</small>
        </div>
      </section>`;
  }

  const course     = state.courses?.[task.courseId];
  const courseName = course?.name || task.courseId;
  const isExam     = task.taskType === 'exam';
  const isQuiz     = task.tool === 'quiz';

  return `
    <section class="orbit-now-strip c-${escapeHtml(task.courseId)}${isExam ? ' exam-strip' : ''}">
      <button class="orbit-now-main" data-action="select-task" data-task-id="${escapeHtml(task.id)}">
        <span>${isExam ? 'Exam today' : 'Task at hand'} · ${escapeHtml(formatOrbitDate(task.scheduledDate || task.date, false))}</span>
        <strong>${escapeHtml(task.title)}</strong>
        <small>${escapeHtml(task.startTime)}-${escapeHtml(task.endTime)} · ${escapeHtml(courseName)}${isExam ? '' : ' · ' + escapeHtml(stageLabel(task.taskType))}</small>
      </button>
      <div class="orbit-now-actions">
        ${isExam
          ? `<span class="exam-badge">Good luck!</span>`
          : `<button class="btn-secondary" data-action="open-course" data-course-id="${escapeHtml(task.courseId)}">Course</button>
             <button class="btn-primary"
               data-action="${isQuiz ? 'quiz-task' : 'tutor-task'}"
               ${isQuiz ? `data-course-id="${escapeHtml(task.courseId)}" data-session-id="${escapeHtml(task.sessionId || '')}"` : `data-task-id="${escapeHtml(task.id)}"`}>
               ${isQuiz ? 'Go to quiz' : (task.taskType === 'first_pass' || task.tool === 'notes') ? 'Write notes' : 'Open tutor'}
             </button>`
        }
      </div>
    </section>`;
}

export function renderCalendarDay(day, selectedTaskId) {
  const isToday      = day.date === state.orbit.data?.today;
  const studyTasks   = day.tasks.filter(t => !isOrbitBreak(t) && t.taskType !== 'exam');
  const done         = studyTasks.filter(t => t.status === 'completed').length;
  const _parseMins   = s => { const m = /^(\d+):(\d+)$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : 510; };
  const wakeMins     = _parseMins(day.wakeTime);
  const bedMins      = _parseMins(day.bedTime);
  const available    = day.summary?.availableStudyMinutes || Math.max(60, Math.round((bedMins - wakeMins) * 0.6 / 15) * 15);
  const dateLabel    = formatOrbitDate(day.date, false);
  const dayNum       = new Date(`${day.date}T12:00:00`).getDate();
  const dayName      = dateLabel.split(' ')[0];

  return `
    <section class="orbit-cal-day ${isToday ? 'today' : ''}"
      data-drop-date="${escapeHtml(day.date)}">
      <div class="orbit-cal-day-head">
        <div>
          <span>${escapeHtml(dayName)}</span>
          <strong>${dayNum}</strong>
        </div>
        <small>${done}/${studyTasks.length}</small>
      </div>
      <div class="orbit-cal-day-budget">
        <label>Study
          <input type="number" min="1" max="12" step="0.5"
            value="${Math.round((available / 60) * 2) / 2}"
            data-action="save-day-time"
            data-date="${escapeHtml(day.date)}"
            data-field="studyMinutes">
          h
        </label>
      </div>
      <div class="orbit-cal-cards">
        ${day.tasks.length
          ? day.tasks.map(t => renderCard(t, selectedTaskId)).join('')
          : '<div class="orbit-cal-empty">No tasks</div>'}
      </div>
    </section>`;
}

export function renderWeekGrid(data, weekOffset, selectedTaskId) {
  const allDays  = data.days || [];
  const startIdx = Math.max(0, Math.min(weekOffset * 7, Math.max(0, allDays.length - 1)));
  const weekDays = allDays.slice(startIdx, startIdx + 7);

  const weekLabel = weekDays.length
    ? `${formatOrbitDate(weekDays[0].date, false)} – ${formatOrbitDate(weekDays[weekDays.length - 1].date, false)}`
    : 'No week';

  return { weekDays, weekLabel };
}
