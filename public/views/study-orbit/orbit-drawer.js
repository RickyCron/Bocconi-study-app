import { escapeHtml, stageLabel, daysUntil, effectiveExamDate } from '../../lib/utils.js';
import { ORBIT_TOOL_LABELS } from '../../config.js';
import { state } from '../../store/store.js';

export function renderDrawer(task) {
  if (!task) return '';

  const course = state.courses?.[task.courseId];
  const courseName = course?.name || task.courseId;
  const exam = effectiveExamDate(task.courseId);
  const toolLabel = ORBIT_TOOL_LABELS[task.tool] || task.tool;

  return `
    <div class="orbit-drawer-backdrop" data-action="deselect-task"></div>
    <aside class="orbit-task-drawer c-${escapeHtml(task.courseId)}">
      <div class="orbit-drawer-top">
        <div class="section-label">Task</div>
        <button class="close-btn" data-action="deselect-task" aria-label="Close">×</button>
      </div>
      <h2>${escapeHtml(task.title)}</h2>
      <div class="orbit-drawer-props">
        <div><span>Course</span><strong>${escapeHtml(courseName)}</strong></div>
        <div><span>Stage</span><strong>${escapeHtml(stageLabel(task.taskType))}</strong></div>
        <div><span>Time</span><strong>${escapeHtml(task.startTime)}-${escapeHtml(task.endTime)}</strong></div>
        <div><span>Duration</span><strong>${task.durationMinutes} min</strong></div>
        <div><span>Tool</span><strong>${escapeHtml(toolLabel)}</strong></div>
        <div><span>Exam</span><strong>${exam ? `${daysUntil(exam)} days` : '—'}</strong></div>
      </div>
      <div class="orbit-drawer-section">
        <div class="section-label">Why scheduled</div>
        <p>${escapeHtml(task.why || task.reasoning || 'Scheduled from lecture order, exam pressure, and available study time.')}</p>
      </div>
      <div class="orbit-drawer-actions">
        ${task.taskType === 'exam' ? `
          <p class="exam-good-luck">Good luck! Nothing to action here — just show up and do your best.</p>
          <button class="btn-secondary" data-action="open-course" data-course-id="${escapeHtml(task.courseId)}">Open course</button>
        ` : `
          <button class="btn-primary"
            data-action="toggle-task-status"
            data-task-id="${escapeHtml(task.id)}"
            data-task-status="${escapeHtml(task.status)}">
            ${task.status === 'completed' ? 'Mark pending' : 'Complete'}
          </button>
          <button class="btn-secondary" data-action="open-course" data-course-id="${escapeHtml(task.courseId)}">Open course</button>
          ${task.tool === 'quiz'
            ? `<button class="btn-secondary" data-action="quiz-task" data-course-id="${escapeHtml(task.courseId)}" data-session-id="${escapeHtml(task.sessionId || '')}">Go to quiz</button>`
            : `<button class="btn-secondary" data-action="tutor-task" data-task-id="${escapeHtml(task.id)}">
                ${task.taskType === 'first_pass' || task.tool === 'notes' ? 'Write notes with tutor' : 'Open tutor chat'}
               </button>`
          }
          <button class="btn-secondary"
            data-action="move-task-tomorrow"
            data-task-id="${escapeHtml(task.id)}">Tomorrow</button>
          <button class="btn-secondary"
            data-action="move-task-next-slot"
            data-task-id="${escapeHtml(task.id)}">Next free slot</button>
          <button class="btn-secondary"
            data-action="shorten-task"
            data-task-id="${escapeHtml(task.id)}">Shorten</button>
          <button class="btn-ghost"
            data-action="skip-task"
            data-task-id="${escapeHtml(task.id)}">Skip</button>
        `}
      </div>
    </aside>`;
}
