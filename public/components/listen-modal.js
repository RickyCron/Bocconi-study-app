import { state } from '../store/store.js';
import { escapeHtml } from '../lib/utils.js';

// ── Module-scoped TTS state ───────────────────────────────────────────────────

const _tts = { text: '', audio: null };

// ── Helpers ───────────────────────────────────────────────────────────────────

function _closeModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.add('closing');
  overlay.addEventListener('animationend', () => {
    overlay.classList.remove('open', 'closing');
  }, { once: true });
}

// ── Public API (window globals) ───────────────────────────────────────────────

window.openListen = async function (courseId, sessionId) {
  _tts.text = '';
  const titleEl    = document.getElementById('listen-title');
  const subtitleEl = document.getElementById('listen-subtitle');
  const textEl     = document.getElementById('listen-text');
  const playBtn    = document.getElementById('btn-play');

  if (titleEl)    titleEl.textContent    = 'Listen · ' + (state.courses?.[courseId]?.name || courseId);
  if (subtitleEl) subtitleEl.textContent = sessionId ? 'Lecture ' + sessionId : 'Course Overview';
  if (textEl)     textEl.textContent     = 'Generating lecture primer…';
  if (playBtn)    playBtn.disabled       = true;

  document.getElementById('listen-modal').classList.add('open');

  try {
    const res  = await fetch('/api/lecture-primer', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ courseId, sessionId }),
    });
    const data = await res.json();
    if (data.text) {
      _tts.text = data.text;
      if (textEl) textEl.textContent = data.text;
      if (playBtn) playBtn.disabled  = false;
    } else {
      if (textEl) textEl.textContent = 'Could not generate primer. ' + escapeHtml(data.error || '');
    }
  } catch (err) {
    if (document.getElementById('listen-text'))
      document.getElementById('listen-text').textContent = 'Error: ' + err.message;
  }
};

window.closeListen = function () {
  window.ttsStop();
  _closeModal('listen-modal');
};

window.ttsPlay = async function () {
  if (!_tts.text) return;

  const playBtn  = document.getElementById('btn-play');
  const pauseBtn = document.getElementById('btn-pause');
  const speedEl  = document.getElementById('listen-speed');

  if (_tts.audio && _tts.audio.paused && _tts.audio.src) {
    _tts.audio.playbackRate = parseFloat(speedEl?.value || '1');
    _tts.audio.play();
    if (playBtn)  playBtn.style.display  = 'none';
    if (pauseBtn) pauseBtn.style.display = 'block';
    return;
  }

  if (playBtn) { playBtn.disabled = true; playBtn.textContent = 'Loading…'; }
  try {
    const res = await fetch('/api/tts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: _tts.text }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'TTS request failed'); }
    const blob  = await res.blob();
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.playbackRate = parseFloat(speedEl?.value || '1');
    audio.onended = () => {
      if (playBtn)  playBtn.style.display  = 'block';
      if (pauseBtn) pauseBtn.style.display = 'none';
      const bar = document.getElementById('tts-progress-bar');
      if (bar) bar.style.width = '0%';
    };
    audio.ontimeupdate = () => {
      if (audio.duration) {
        const bar = document.getElementById('tts-progress-bar');
        if (bar) bar.style.width = (audio.currentTime / audio.duration * 100) + '%';
      }
    };
    _tts.audio = audio;
    audio.play();
  } catch (err) {
    alert('Audio error: ' + err.message);
  } finally {
    if (playBtn) { playBtn.disabled = false; playBtn.textContent = 'Play'; }
  }
  if (playBtn)  playBtn.style.display  = 'none';
  if (pauseBtn) pauseBtn.style.display = 'block';
};

window.ttsPause = function () {
  if (_tts.audio) _tts.audio.pause();
  const playBtn  = document.getElementById('btn-play');
  const pauseBtn = document.getElementById('btn-pause');
  if (playBtn)  playBtn.style.display  = 'block';
  if (pauseBtn) pauseBtn.style.display = 'none';
};

window.ttsStop = function () {
  if (_tts.audio) { _tts.audio.pause(); _tts.audio.src = ''; _tts.audio = null; }
  const playBtn  = document.getElementById('btn-play');
  const pauseBtn = document.getElementById('btn-pause');
  const bar      = document.getElementById('tts-progress-bar');
  if (playBtn)  playBtn.style.display  = 'block';
  if (pauseBtn) pauseBtn.style.display = 'none';
  if (bar)      bar.style.width = '0%';
};

window.ttsUpdateSpeed = function () {
  const speedEl = document.getElementById('listen-speed');
  if (_tts.audio && !_tts.audio.paused && speedEl) {
    _tts.audio.playbackRate = parseFloat(speedEl.value);
  }
};

