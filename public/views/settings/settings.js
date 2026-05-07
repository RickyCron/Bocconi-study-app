import { state } from '../../store/store.js';
import { escapeHtml } from '../../lib/utils.js';
import { showToast } from '../../lib/toast.js';

const VOICE_SETTINGS_KEY = 'voice-settings';

function loadVoiceSettings() {
  try { return JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}

function saveVoiceSettings(s) {
  try { localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function loadTtsSpeed() {
  return parseFloat(localStorage.getItem('tts-speed') || '1.6');
}

function saveTtsSpeed(v) {
  try { localStorage.setItem('tts-speed', String(v)); } catch {}
}

export function mount(container) {
  const vs = loadVoiceSettings();
  const ttsSpeed = loadTtsSpeed();

  container.innerHTML = `
    <div style="max-width:560px; margin:0 auto;">
      <div class="page-hd"><h2 class="page-title">Settings</h2></div>

      <div class="settings-section">
        <div class="settings-label">Account</div>
        <p class="settings-desc">Signed in as <strong>${escapeHtml(state.user || '')}</strong></p>
        <button id="settings-signout-btn" style="background:var(--surface-2);color:var(--t2);border:1px solid var(--border);padding:0.5rem 1rem;">Sign out</button>
      </div>

      <div class="settings-section">
        <div class="settings-label">Anthropic API key</div>
        <p class="settings-desc">Required for AI Tutor, orbit chat, and question generation. Get yours at console.anthropic.com — paste just the key (starts with <code>sk-ant-</code>), nothing else.</p>
        <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">
          <input type="password" id="anthropic-key-input" placeholder="sk-ant-…" autocomplete="off"
            style="flex:1;padding:0.5rem 0.75rem;background:var(--surface-2);color:var(--t1);border:1px solid var(--border);border-radius:0.5rem;font-family:monospace;font-size:0.8125rem;">
          <button id="anthropic-key-save" class="btn-primary" style="padding:0.5rem 1rem;white-space:nowrap;">Save</button>
        </div>
        <div id="anthropic-key-status" style="font-size:0.8125rem;color:var(--t3);"></div>
      </div>

      <div class="settings-section">
        <div class="settings-label">OpenAI API key</div>
        <p class="settings-desc">Required for voice chat (TTS + Whisper). Get yours at platform.openai.com — paste just the key (starts with <code>sk-</code>), nothing else.</p>
        <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">
          <input type="password" id="openai-key-input" placeholder="sk-…" autocomplete="off"
            style="flex:1;padding:0.5rem 0.75rem;background:var(--surface-2);color:var(--t1);border:1px solid var(--border);border-radius:0.5rem;font-family:monospace;font-size:0.8125rem;">
          <button id="openai-key-save" class="btn-primary" style="padding:0.5rem 1rem;white-space:nowrap;">Save</button>
        </div>
        <div id="openai-key-status" style="font-size:0.8125rem;color:var(--t3);"></div>
      </div>

      <div class="settings-section">
        <div class="settings-label">TTS speed</div>
        <p class="settings-desc">Preferred speed for Listen mode</p>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <span style="font-size:0.8125rem;color:var(--t3);">0.8x</span>
          <input type="range" min="0.8" max="2.5" step="0.1" value="${ttsSpeed}" id="tts-speed-setting"
            style="flex:1;padding:0;border:none;background:transparent;">
          <span style="font-size:0.8125rem;color:var(--t3);">2.5x</span>
          <span style="font-size:0.875rem;font-weight:600;color:var(--accent);width:3rem;text-align:right;" id="tts-speed-label">${ttsSpeed}x</span>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-label">Voice chat</div>
        <p class="settings-desc">Tutor voice for conversations</p>
        <select id="voice-voice-setting" style="width:100%;padding:0.5rem 0.75rem;background:var(--surface-2);color:var(--t1);border:1px solid var(--border);border-radius:0.5rem;">
          <option value="nova"    ${vs.voice === 'nova'    || !vs.voice ? 'selected' : ''}>Nova (warm female)</option>
          <option value="shimmer" ${vs.voice === 'shimmer' ? 'selected' : ''}>Shimmer (bright female)</option>
          <option value="alloy"   ${vs.voice === 'alloy'   ? 'selected' : ''}>Alloy (neutral)</option>
          <option value="echo"    ${vs.voice === 'echo'    ? 'selected' : ''}>Echo (male)</option>
          <option value="fable"   ${vs.voice === 'fable'   ? 'selected' : ''}>Fable (British male)</option>
          <option value="onyx"    ${vs.voice === 'onyx'    ? 'selected' : ''}>Onyx (deep male)</option>
        </select>
        <p class="settings-desc" style="margin-top:1rem;">VAD sensitivity — lower = picks up quieter speech, higher = stricter (better for noisy rooms)</p>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <span style="font-size:0.8125rem;color:var(--t3);">Quiet</span>
          <input type="range" min="0.3" max="0.8" step="0.05" value="${vs.sensitivity ?? 0.5}" id="voice-sensitivity-setting"
            style="flex:1;padding:0;border:none;background:transparent;">
          <span style="font-size:0.8125rem;color:var(--t3);">Loud</span>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-label">Reset progress</div>
        <p class="settings-desc">Clear all session coverage marks and quiz scores</p>
        <button id="settings-reset-btn" style="background:oklch(0.35 0.13 15 / 0.15);color:var(--red);border:1px solid oklch(0.35 0.13 15 / 0.3);padding:0.5rem 1rem;">
          Reset all progress
        </button>
      </div>
    </div>
  `;

  // Load current key status
  fetch('/api/user/keys').then(r => r.json()).then(data => {
    const aStatus = container.querySelector('#anthropic-key-status');
    const oStatus = container.querySelector('#openai-key-status');
    if (aStatus) aStatus.textContent = data.anthropic_set ? `Saved (${data.anthropic_key})` : 'Not set';
    if (oStatus) oStatus.textContent = data.openai_set    ? `Saved (${data.openai_key})`    : 'Not set';
  }).catch(() => {});

  async function saveKey(field, inputId, statusId) {
    const input = container.querySelector(inputId);
    const status = container.querySelector(statusId);
    const value = input.value.trim();
    if (!value) return;
    try {
      const r = await fetch('/api/user/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      input.value = '';
      status.textContent = `Saved (${value.slice(0, 10)}…)`;
      showToast('Key saved', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to save key', 'error');
    }
  }

  container.querySelector('#anthropic-key-save').addEventListener('click', () =>
    saveKey('anthropic_key', '#anthropic-key-input', '#anthropic-key-status'));
  container.querySelector('#openai-key-save').addEventListener('click', () =>
    saveKey('openai_key', '#openai-key-input', '#openai-key-status'));

  // TTS speed slider
  const speedSlider = container.querySelector('#tts-speed-setting');
  const speedLabel  = container.querySelector('#tts-speed-label');
  speedSlider.addEventListener('input', () => {
    speedLabel.textContent = speedSlider.value + 'x';
    saveTtsSpeed(parseFloat(speedSlider.value));
  });

  // Voice settings
  const voiceSel = container.querySelector('#voice-voice-setting');
  const sensSel  = container.querySelector('#voice-sensitivity-setting');

  function persistVoiceSettings() {
    const s = loadVoiceSettings();
    s.voice = voiceSel.value;
    s.sensitivity = parseFloat(sensSel.value);
    saveVoiceSettings(s);
    window.updateVoiceSettings?.();
  }

  voiceSel.addEventListener('change', persistVoiceSettings);
  sensSel.addEventListener('input',  persistVoiceSettings);

  // Sign out
  container.querySelector('#settings-signout-btn').addEventListener('click', () => {
    window.logout?.();
  });

  // Reset progress
  container.querySelector('#settings-reset-btn').addEventListener('click', () => {
    if (!confirm('Clear all progress? This cannot be undone.')) return;
    state.progress = {};
    fetch('/api/progress', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
    });
  });
}
