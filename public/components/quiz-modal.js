import { state }            from '../store/store.js';
import { escapeHtml, shuffle, getWrongCount } from '../lib/utils.js';
import { saveProgress }     from '../lib/api.js';
import { animateStaggerItems } from '../lib/utils.js';

// ── Module-scoped quiz state ──────────────────────────────────────────────────

const _quiz = { questions: [], idx: 0, score: 0, answered: false, isDrill: false, cleared: 0 };
let _currentCourse = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _closeModal(id, callback) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.add('closing');
  overlay.addEventListener('animationend', () => {
    overlay.classList.remove('open', 'closing');
    if (callback) callback();
  }, { once: true });
}

function _spawnConfetti(container) {
  const colors = ['var(--green)', 'var(--accent)', 'var(--c-gtm)', 'oklch(0.75 0.14 55)', 'oklch(0.70 0.13 160)'];
  const wrap = document.createElement('div');
  wrap.className = 'confetti-wrap';
  container.style.position = 'relative';
  container.appendChild(wrap);
  for (let i = 0; i < 24; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    p.style.cssText = `left:${(Math.random() * 200 - 100)}px;top:-10px;background:${colors[Math.floor(Math.random() * colors.length)]};border-radius:${Math.random() > 0.5 ? '50%' : '2px'};animation-delay:${Math.random() * 400}ms;animation-duration:${700 + Math.random() * 400}ms;`;
    wrap.appendChild(p);
  }
  setTimeout(() => wrap.remove(), 1500);
}

// ── Render ────────────────────────────────────────────────────────────────────

function _renderQuestion() {
  const q = _quiz.questions[_quiz.idx];
  if (!q) return;

  const total = _quiz.questions.length;
  const idx   = _quiz.idx;

  document.getElementById('quiz-progress-label').textContent = `Question ${idx + 1} of ${total}`;
  document.getElementById('quiz-score-display').textContent  = `${_quiz.score}/${idx}`;

  const dotsHTML = Array.from({ length: total }, (_, i) =>
    `<div class="quiz-dot${i < idx ? ' done' : i === idx ? ' current' : ''}"></div>`
  ).join('');

  if (q.type === 'open') {
    const kp = (q.key_points || []).map(p => `<li style="margin-bottom:0.375rem;color:var(--t2);">${escapeHtml(p)}</li>`).join('');
    document.getElementById('quiz-body').innerHTML = `
      <div>
        <div class="quiz-progress-dots">${dotsHTML}</div>
        <div class="quiz-q-text">${escapeHtml(q.question)}</div>
        <textarea id="open-answer" style="width:100%;min-height:130px;margin-top:0;padding:0.75rem;background:var(--bg);border:1px solid var(--border-2);border-radius:0.5rem;color:var(--t1);font-family:inherit;font-size:0.9rem;resize:vertical;line-height:1.6;" placeholder="Write your answer…"></textarea>
        <button id="open-submit" style="margin-top:0.75rem;width:100%;" class="btn-primary">Submit answer</button>
        ${_quiz.answered ? `
          <div class="quiz-explanation">
            <div style="font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--accent);margin-bottom:0.625rem;">Model answer</div>
            <div style="color:var(--t2);line-height:1.7;margin-bottom:0.875rem;">${escapeHtml(q.model_answer)}</div>
            <ul style="padding-left:1.25rem;font-size:0.875rem;">${kp}</ul>
          </div>
          <button id="open-next" style="margin-top:0.75rem;width:100%;" class="btn-primary">Next →</button>` : ''}
      </div>`;
    document.getElementById('open-submit')?.addEventListener('click', _submitOpenAnswer);
    document.getElementById('open-next')?.addEventListener('click', _dismissFeedback);
    return;
  }

  const keys    = shuffle(['a', 'b', 'c', 'd']);
  const optHTML = keys.map(key => `
    <button class="quiz-option stagger-item" data-key="${key}" ${_quiz.answered ? 'disabled' : ''}>
      <span class="quiz-option-key">${key.toUpperCase()}</span>
      <span>${escapeHtml(q.options[key])}</span>
    </button>`).join('');

  document.getElementById('quiz-body').innerHTML = `
    <div>
      <div class="quiz-progress-dots">${dotsHTML}</div>
      <div class="quiz-q-text stagger-item">${escapeHtml(q.question)}</div>
      <div class="quiz-options">${optHTML}</div>
      ${_quiz.answered ? `
        <div class="quiz-explanation">${escapeHtml(q.explanation || '')}</div>
        <button id="mcq-next" style="margin-top:0.75rem;width:100%;" class="btn-primary stagger-item">Next →</button>` : ''}
    </div>`;

  requestAnimationFrame(() => animateStaggerItems(document.getElementById('quiz-body')));

  document.querySelectorAll('.quiz-option').forEach(btn => {
    btn.addEventListener('click', () => _answerQuiz(btn.dataset.key));
  });
  document.getElementById('mcq-next')?.addEventListener('click', _dismissFeedback);
}

function _submitOpenAnswer() {
  _quiz.answered = true;
  if (!state.progress[_currentCourse]) state.progress[_currentCourse] = {};
  _renderQuestion();
}

function _answerQuiz(key) {
  if (_quiz.answered) return;
  const q = _quiz.questions[_quiz.idx];
  const isCorrect = key === q.correct;

  document.querySelectorAll('.quiz-option').forEach(b => {
    if (b.dataset.key === q.correct) b.classList.add('correct');
    if (b.dataset.key === key && !isCorrect) b.classList.add('wrong');
    b.disabled = true;
  });

  if (isCorrect) _quiz.score++;
  _quiz.answered = true;

  if (!state.progress[_currentCourse]) state.progress[_currentCourse] = {};
  if (!state.progress[_currentCourse][q.session]) state.progress[_currentCourse][q.session] = {};
  state.progress[_currentCourse][q.session].quizScore = Math.round((_quiz.score / (_quiz.idx + 1)) * 100);

  fetch('/api/quiz-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: q.id, courseId: _currentCourse, sessionId: q.session || 'unknown', selectedAnswer: key, isCorrect }),
  }).catch(() => {});

  window.StudySession?.ping(_currentCourse, isCorrect);

  if (!state.progress[_currentCourse].wrongQuestions) state.progress[_currentCourse].wrongQuestions = [];
  const wq = state.progress[_currentCourse].wrongQuestions;
  if (!isCorrect) {
    if (!wq.includes(q.id)) wq.push(q.id);
  } else {
    const wi = wq.indexOf(q.id);
    if (wi !== -1) { wq.splice(wi, 1); _quiz.cleared++; }
  }
  document.getElementById('quiz-score-display').textContent = `${_quiz.score}/${_quiz.idx + 1}`;

  const isLast  = _quiz.idx + 1 >= _quiz.questions.length;
  const nextLbl = isLast ? 'See results' : 'Continue';
  const arrow   = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0"><path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  let bodyHTML;
  if (isCorrect) {
    const lines = ['Solid. Here\'s why that\'s right:', 'Correct. Lock this in:', 'That\'s it. The key concept:', 'Right. Worth understanding why:'];
    bodyHTML = `<div class="feedback-body"><p class="feedback-explanation"><strong style="color:var(--t1)">${lines[Math.floor(Math.random() * lines.length)]}</strong><br>${escapeHtml(q.explanation || 'No explanation available.')}</p></div>`;
  } else {
    bodyHTML = `
      <div class="feedback-body">
        <div class="feedback-wrong-answer"><span class="feedback-answer-tag">You picked</span><span>${escapeHtml(q.options[key] || '—')}</span></div>
        <div class="feedback-correct-answer"><span class="feedback-answer-tag">Correct</span><span>${escapeHtml(q.options[q.correct] || '—')}</span></div>
        <p class="feedback-explanation">${escapeHtml(q.explanation || 'No explanation available.')}</p>
      </div>`;
  }

  const panel = document.createElement('div');
  panel.className = `quiz-feedback-panel ${isCorrect ? 'correct-panel' : 'wrong-panel'}`;
  panel.id = 'quiz-feedback';
  panel.innerHTML = `
    <div class="feedback-header">
      <div class="feedback-icon">${isCorrect ? '✓' : '✕'}</div>
      <div class="feedback-label">${isCorrect ? 'Correct' : 'Not quite'}</div>
    </div>
    ${bodyHTML}
    <button class="feedback-next-btn" id="feedback-dismiss">${nextLbl} ${arrow}</button>`;

  document.getElementById('quiz-body').appendChild(panel);
  panel.querySelector('#feedback-dismiss').addEventListener('click', _dismissFeedback);
  requestAnimationFrame(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}

function _dismissFeedback() {
  const panel = document.getElementById('quiz-feedback');
  if (!panel) { _nextQuestion(); return; }
  panel.classList.add('hiding');
  panel.addEventListener('animationend', () => { panel.remove(); _nextQuestion(); }, { once: true });
}

function _nextQuestion() {
  _quiz.idx++;
  _quiz.answered = false;
  if (_quiz.idx < _quiz.questions.length) {
    _renderQuestion();
    return;
  }

  const finalScore = Math.round((_quiz.score / _quiz.questions.length) * 100);
  const scoreColor = finalScore >= 70 ? 'var(--green)' : finalScore >= 50 ? 'var(--c-gtm)' : 'var(--red)';
  const msg        = finalScore >= 80 ? 'Strong result.' : finalScore >= 60 ? 'Getting there.' : 'More revision needed.';
  const remaining  = getWrongCount();
  const drillFooter = _quiz.isDrill
    ? `<div style="font-size:0.8125rem;color:var(--t3);margin-bottom:2rem;">${_quiz.cleared > 0 ? `${_quiz.cleared} weak point${_quiz.cleared !== 1 ? 's' : ''} cleared` : 'Keep drilling to clear them'}${remaining > 0 ? ` · ${remaining} remaining` : ' · All clear'}</div>`
    : `<div style="font-size:0.875rem;color:var(--t3);margin-bottom:2rem;">${msg}</div>`;

  saveProgress();

  document.getElementById('quiz-body').innerHTML = `
    <div style="text-align:center;padding:2.5rem 0;position:relative;" id="score-wrap">
      <div style="font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--t3);margin-bottom:1rem;">${_quiz.isDrill ? 'Drill complete' : 'Quiz complete'}</div>
      <div class="score-reveal" style="font-family:'Geist Mono',monospace;font-size:3.5rem;font-weight:800;color:${scoreColor};line-height:1;letter-spacing:-0.04em;margin-bottom:0.5rem;">${finalScore}%</div>
      <div style="font-size:0.9375rem;color:var(--t2);margin-bottom:0.375rem;">${_quiz.score} of ${_quiz.questions.length} correct</div>
      ${drillFooter}
      ${remaining > 0 && _quiz.isDrill ? `<button id="drill-again-btn" class="btn-secondary" style="margin-right:0.5rem;">Drill again</button>` : ''}
      <button id="quiz-done-btn" class="btn-primary">Done</button>
    </div>`;

  if (finalScore >= 60) {
    requestAnimationFrame(() => {
      const wrap = document.getElementById('score-wrap');
      if (wrap) _spawnConfetti(wrap);
    });
  }

  document.getElementById('quiz-done-btn')?.addEventListener('click', window.closeQuiz);
  document.getElementById('drill-again-btn')?.addEventListener('click', () => {
    window.closeQuiz();
    setTimeout(() => window.openWeakDrill?.(), 100);
  });
}

// ── Public API (window globals) ───────────────────────────────────────────────

window.openQuiz = async function (courseId, sessionId = null) {
  const allQs = state.questions?.[courseId] || [];
  if (!allQs.length) { alert('No questions available yet.'); return; }

  let qs;
  if (sessionId) {
    qs = shuffle(allQs.filter(q => q.session === sessionId || q.session === 'open' || q.session === 'general')).slice(0, 10);
  } else {
    try {
      const adapted = await fetch(`/api/adaptive-questions?courseId=${courseId}&count=10`).then(r => r.json());
      qs = Array.isArray(adapted) && adapted.length > 0 ? adapted : shuffle(allQs).slice(0, 10);
    } catch {
      qs = shuffle(allQs).slice(0, 10);
    }
  }

  if (!qs.length) { alert('No questions available yet.'); return; }
  _currentCourse = courseId;
  Object.assign(_quiz, { questions: qs, idx: 0, score: 0, answered: false, isDrill: false, cleared: 0 });
  document.getElementById('quiz-title').textContent = (state.courses?.[courseId]?.name || courseId) + (sessionId ? ' · Lecture ' + sessionId : '');
  document.getElementById('quiz-modal').classList.add('open');
  _renderQuestion();
};

window.openWeakDrill = function (courseId) {
  let qs, title;
  if (courseId) {
    const wrong = state.progress?.[courseId]?.wrongQuestions || [];
    qs    = (state.questions?.[courseId] || []).filter(q => wrong.includes(q.id));
    title = (state.courses?.[courseId]?.name || courseId) + ' · Weak points';
    _currentCourse = courseId;
  } else {
    qs = Object.entries(state.questions || {}).flatMap(([cid, courseQs]) => {
      const wrong = state.progress?.[cid]?.wrongQuestions || [];
      return courseQs.filter(q => wrong.includes(q.id));
    });
    title = 'Weak points · All courses';
    _currentCourse = qs[0]?.id?.split('-')[1] || Object.keys(state.courses || {})[0];
  }
  if (!qs.length) return;
  Object.assign(_quiz, { questions: shuffle(qs), idx: 0, score: 0, answered: false, isDrill: true, cleared: 0 });
  document.getElementById('quiz-title').textContent = title;
  document.getElementById('quiz-modal').classList.add('open');
  _renderQuestion();
};

window.closeQuiz = function () {
  if (speechSynthesis.speaking) speechSynthesis.cancel();
  _closeModal('quiz-modal', () => {
    Object.assign(_quiz, { questions: [], idx: 0, score: 0, answered: false });
  });
};

