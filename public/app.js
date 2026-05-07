import { state } from './store/store.js';
import { auth, loadAppData, syncChatsFromServer } from './lib/api.js';
import { showToast } from './lib/toast.js';
import { navigate, registerView } from './router.js';

// ── View modules ──────────────────────────────────────────────────────────────
import * as settingsMod     from './views/settings/settings.js';
import * as dashboardMod    from './views/dashboard/dashboard.js';
import * as coursesMod      from './views/courses/courses.js';
import * as courseDetailMod from './views/course-detail/course-detail.js';
import * as tutorMod        from './views/tutor/tutor.js';
import * as orbitMod        from './views/study-orbit/orbit.js';
import                           './views/tutor/tutor-voice.js';
import                           './components/quiz-modal.js';
import                           './components/listen-modal.js';

registerView('settings',      settingsMod);
registerView('dashboard',     dashboardMod);
registerView('courses',       coursesMod);
registerView('course-detail', courseDetailMod);
registerView('tutor',         tutorMod);
registerView('study-orbit',   orbitMod);

// ── Study session tracker ─────────────────────────────────────────────────────

const StudySession = {
  id: null,
  startTime: null,
  notified: false,

  start() {
    if (this.id) return;
    fetch('/api/session/start', { method: 'POST' })
      .then(r => r.json())
      .then(({ sessionId }) => {
        this.id = sessionId;
        this.startTime = Date.now();
        this.notified = false;
        sessionStorage.setItem('studySessionId', sessionId);
        sessionStorage.setItem('studySessionStart', String(this.startTime));
      })
      .catch(() => {});
  },

  ping(courseId, isCorrect) {
    if (!this.id) { this.start(); return; }
    fetch('/api/session/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: this.id, courseId, isCorrect }),
    }).catch(() => {});
    this._checkHourMark();
  },

  async _checkHourMark() {
    if (this.notified || !this.startTime) return;
    if (Date.now() - this.startTime < 3_600_000) return;
    this.notified = true;
    try {
      const data = await fetch(`/api/session/summary/${this.id}`).then(r => r.json());
      const { totalAnswered, accuracy, weakestTopic } = data;
      const weakLine = weakestTopic ? ` Weak area: ${weakestTopic}.` : '';
      const msg = `60-min check-in: ${totalAnswered} questions, ${accuracy}% accuracy.${weakLine}`;
      showToast(msg);
      if (Notification.permission === 'granted') {
        new Notification('Bocconi Study — Check-in', { body: msg, icon: '/favicon.ico' });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => {
          if (p === 'granted') new Notification('Bocconi Study — Check-in', { body: msg });
        });
      }
    } catch {}
  },

  end() {
    if (!this.id) return;
    navigator.sendBeacon('/api/session/end', JSON.stringify({ sessionId: this.id }));
    this.id = null;
    this.startTime = null;
    this.notified = false;
    sessionStorage.removeItem('studySessionId');
    sessionStorage.removeItem('studySessionStart');
  },
};

(function resumeSession() {
  const saved = sessionStorage.getItem('studySessionId');
  const savedStart = sessionStorage.getItem('studySessionStart');
  if (saved) {
    StudySession.id = saved;
    StudySession.startTime = parseInt(savedStart, 10) || Date.now();
  }
})();

window.addEventListener('beforeunload', () => StudySession.end());
window.StudySession = StudySession;

// ── Login ─────────────────────────────────────────────────────────────────────

let _loginPin = '';
let _loginUsername = '';
let _loginIsNewUser = false;
let _loginPinConfirmStep = false;
let _loginPinFirst = '';

function _updateLoginDots() {
  document.querySelectorAll('#login-dots span').forEach((dot, i) => {
    dot.classList.toggle('filled', i < _loginPin.length);
  });
}

async function _submitLogin() {
  if (_loginIsNewUser && !_loginPinConfirmStep) {
    _loginPinConfirmStep = true;
    _loginPinFirst = _loginPin;
    _loginPin = '';
    _updateLoginDots();
    document.getElementById('login-pin-label').textContent = 'Confirm your PIN';
    document.getElementById('login-error').textContent = '';
    return;
  }

  if (_loginIsNewUser && _loginPinConfirmStep && _loginPin !== _loginPinFirst) {
    const dots = document.getElementById('login-dots');
    dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');
    document.getElementById('login-error').textContent = "PINs don't match — try again";
    _loginPin = '';
    _loginPinConfirmStep = false;
    _updateLoginDots();
    document.getElementById('login-pin-label').textContent = 'Create a 4-digit PIN';
    return;
  }

  const endpoint = _loginIsNewUser ? '/api/auth/register' : '/api/auth/login';
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: _loginUsername, pin: _loginPin }),
    });
    const data = await r.json();
    if (!r.ok) {
      const dots = document.getElementById('login-dots');
      dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');
      document.getElementById('login-error').textContent = data.error || 'Something went wrong';
      _loginPin = '';
      _loginPinConfirmStep = false;
      _updateLoginDots();
      if (_loginIsNewUser) document.getElementById('login-pin-label').textContent = 'Create a 4-digit PIN';
      return;
    }
    state.user = data.username;
    afterLogin();
  } catch {
    document.getElementById('login-error').textContent = 'Connection error';
    _loginPin = '';
    _loginPinConfirmStep = false;
    _updateLoginDots();
  }
}

window.loginStepPin = async function () {
  const input = document.getElementById('login-username-input');
  const username = input.value.trim();
  if (!username) { input.focus(); return; }

  const btn = document.querySelector('.login-continue-btn');
  btn.disabled = true;
  btn.textContent = '…';

  let exists = false;
  try {
    const r = await fetch('/api/auth/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    if (!r.ok) throw new Error('bad response');
    ({ exists } = await r.json());
  } catch {
    btn.disabled = false;
    btn.textContent = 'Continue';
    let errEl = document.getElementById('login-srv-err');
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.id = 'login-srv-err';
      errEl.style.cssText = 'color:var(--red);font-size:0.8125rem;margin-top:0.5rem;text-align:center;';
      document.getElementById('login-step-username').appendChild(errEl);
    }
    errEl.textContent = 'Could not reach server — is it running?';
    return;
  }

  btn.disabled = false;
  btn.textContent = 'Continue';
  _loginUsername = username;
  _loginIsNewUser = !exists;
  _loginPin = '';
  _loginPinConfirmStep = false;
  document.getElementById('login-step-username').classList.add('login-step-hidden');
  document.getElementById('login-step-pin').classList.remove('login-step-hidden');
  document.getElementById('login-user-badge').textContent = _loginUsername;
  document.getElementById('login-pin-label').textContent = _loginIsNewUser ? 'Create a 4-digit PIN' : 'Enter your PIN';
  document.getElementById('login-error').textContent = '';
  _updateLoginDots();
};

window.loginStepBack = function () {
  _loginPin = '';
  _loginPinConfirmStep = false;
  document.getElementById('login-step-pin').classList.add('login-step-hidden');
  document.getElementById('login-step-username').classList.remove('login-step-hidden');
  document.getElementById('login-username-input').focus();
};

window.loginPinDigit = function (d) {
  if (_loginPin.length >= 4) return;
  _loginPin += d;
  _updateLoginDots();
  if (_loginPin.length === 4) setTimeout(_submitLogin, 120);
};

window.loginPinBackspace = function () {
  if (!_loginPin.length) return;
  _loginPin = _loginPin.slice(0, -1);
  _updateLoginDots();
};

document.addEventListener('keydown', e => {
  const pinStep = document.getElementById('login-step-pin');
  if (!pinStep || pinStep.classList.contains('login-step-hidden')) return;
  if (e.key >= '0' && e.key <= '9') window.loginPinDigit(e.key);
  else if (e.key === 'Backspace') window.loginPinBackspace();
});

// ── Change PIN modal ──────────────────────────────────────────────────────────

let _cpPin = '';
let _cpStep = 1;
let _cpCurrentPin = '';

function _updateCpDots() {
  document.querySelectorAll('#pin-change-dots span').forEach((dot, i) => {
    dot.classList.toggle('filled', i < _cpPin.length);
  });
}

async function _submitCpStep() {
  if (_cpStep === 1) {
    try {
      const r = await fetch('/api/auth/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: _cpPin }),
      });
      if (!r.ok) {
        const dots = document.getElementById('pin-change-dots');
        dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');
        document.getElementById('pin-change-error').textContent = 'Incorrect PIN';
        _cpPin = ''; _updateCpDots(); return;
      }
    } catch {
      document.getElementById('pin-change-error').textContent = 'Connection error';
      _cpPin = ''; _updateCpDots(); return;
    }
    _cpCurrentPin = _cpPin;
    _cpPin = ''; _cpStep = 2;
    document.getElementById('pin-change-label').textContent = 'Enter your new PIN';
    document.getElementById('pin-change-error').textContent = '';
    _updateCpDots();
  } else {
    try {
      const r = await fetch('/api/auth/change-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPin: _cpCurrentPin, newPin: _cpPin }),
      });
      if (!r.ok) {
        const data = await r.json();
        document.getElementById('pin-change-error').textContent = data.error || 'Failed to change PIN';
        _cpPin = ''; _updateCpDots(); return;
      }
    } catch {
      document.getElementById('pin-change-error').textContent = 'Connection error';
      _cpPin = ''; _updateCpDots(); return;
    }
    window.closeChangePinModal();
  }
}

window.showChangePinModal = function () {
  window.closeProfileMenu();
  _cpPin = ''; _cpStep = 1; _cpCurrentPin = '';
  document.getElementById('pin-change-title').textContent = 'Change PIN';
  document.getElementById('pin-change-label').textContent = 'Enter your current PIN';
  document.getElementById('pin-change-error').textContent = '';
  _updateCpDots();
  document.getElementById('pin-change-modal').style.display = 'flex';
};

window.closeChangePinModal = function () {
  document.getElementById('pin-change-modal').style.display = 'none';
};

window.cpDigit = function (d) {
  if (_cpPin.length >= 4) return;
  _cpPin += d;
  _updateCpDots();
  if (_cpPin.length === 4) setTimeout(_submitCpStep, 120);
};

window.cpBackspace = function () {
  if (!_cpPin.length) return;
  _cpPin = _cpPin.slice(0, -1);
  _updateCpDots();
};

document.addEventListener('keydown', e => {
  const modal = document.getElementById('pin-change-modal');
  if (!modal || modal.style.display === 'none') return;
  if (e.key >= '0' && e.key <= '9') window.cpDigit(e.key);
  else if (e.key === 'Backspace') window.cpBackspace();
  else if (e.key === 'Escape') window.closeChangePinModal();
});

// ── Profile menu ──────────────────────────────────────────────────────────────

window.toggleProfileMenu = function () {
  document.getElementById('profile-dropdown').classList.toggle('open');
};

window.closeProfileMenu = function () {
  document.getElementById('profile-dropdown')?.classList.remove('open');
};

document.addEventListener('click', e => {
  if (!document.getElementById('nav-profile-wrap')?.contains(e.target)) {
    window.closeProfileMenu();
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────

window.logout = async function () {
  window.closeProfileMenu();
  StudySession.end();
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  state.user = null;
  state.courses = null;
  state.questions = null;
  state.progress = {};
  state.orbit.data = null;
  _loginPin = '';
  _loginUsername = '';
  document.getElementById('login-username-input').value = '';
  document.getElementById('login-step-pin').classList.add('login-step-hidden');
  document.getElementById('login-step-username').classList.remove('login-step-hidden');
  document.getElementById('login-error').textContent = '';
  document.getElementById('nav-profile-wrap').style.display = 'none';
  const overlay = document.getElementById('login-overlay');
  overlay.style.display = '';
  overlay.classList.remove('login-hide');
};

// ── After login ───────────────────────────────────────────────────────────────

function afterLogin() {
  const overlay = document.getElementById('login-overlay');
  overlay.classList.add('login-hide');
  setTimeout(() => { overlay.style.display = 'none'; }, 380);

  document.getElementById('nav-profile-wrap').style.display = 'flex';
  document.getElementById('nav-profile-avatar').textContent = state.user[0].toUpperCase();
  document.getElementById('nav-profile-uname').textContent = state.user;
  document.getElementById('profile-dd-user').textContent = state.user;

  StudySession.start();
  loadAppData().then(() => syncChatsFromServer()).catch(() => {});
  navigate('dashboard');
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const { username } = await auth.me();
    state.user = username;
    afterLogin();
  } catch {
    // overlay stays visible — server may be down or not authenticated
  }
}

init();
