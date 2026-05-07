import { escapeHtml, stageLabel, isOrbitBreak } from '../../lib/utils.js';
import { ORBIT_TOOL_LABELS } from '../../config.js';

export function renderCard(task, selectedTaskId) {
  if (isOrbitBreak(task)) {
    return `
      <div class="orbit-cal-break">
        <span>${escapeHtml(task.startTime)}</span>
        <strong>${escapeHtml(task.title)}</strong>
      </div>`;
  }

  if (task.taskType === 'exam') {
    return `
      <button class="orbit-cal-card orbit-cal-exam c-${escapeHtml(task.courseId)}"
        data-action="select-task" data-task-id="${escapeHtml(task.id)}">
        <span class="orbit-cal-time">${escapeHtml(task.startTime)}-${escapeHtml(task.endTime)}</span>
        <strong>🎓 ${escapeHtml(task.title)}</strong>
        <small>Exam</small>
      </button>`;
  }

  const selected = selectedTaskId === task.id;
  const toolLabel = ORBIT_TOOL_LABELS[task.tool] || task.tool;

  return `
    <button class="orbit-cal-card c-${escapeHtml(task.courseId)} ${task.status === 'completed' ? 'done' : ''} ${selected ? 'selected' : ''}"
      draggable="true"
      data-action="select-task"
      data-task-id="${escapeHtml(task.id)}"
      data-drag-task-id="${escapeHtml(task.id)}">
      <span class="orbit-cal-time">${escapeHtml(task.startTime)}-${escapeHtml(task.endTime)}</span>
      <strong>${escapeHtml(task.title.replace(/^Lecture /, 'L'))}</strong>
      <small>${escapeHtml(stageLabel(task.taskType))} · ${escapeHtml(toolLabel)}</small>
    </button>`;
}
