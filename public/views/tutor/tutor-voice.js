import { state } from '../../store/store.js';
import { loadChatData, saveChatData } from '../../lib/api.js';

// Voice module — sets window.openVoiceModal, window.closeVoiceModal, window.toggleVoiceMute
// References window.vad and window.ort (loaded by pre-module <script> tags in index.html)

const VOICE_SETTINGS_KEY = 'voice-settings';

const Voice = {
  state: 'idle',
  courseId: null,
  convId: null,
  resumed: false,
  history: [],
  summary: '',
  summarizedUpTo: 0,
  summarizing: false,
  origTitle: null,
  origCreated: null,
  vad: null,
  audioPlaying: null,
  abortCtrl: null,
  muted: false,
  settings: { voice: 'nova', sensitivity: 0.5 },
};

let playChain = Promise.resolve();
let firstAudioStarted = false;

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) || '{}');
    if (s.voice) Voice.settings.voice = s.voice;
    if (typeof s.sensitivity === 'number') {
      Voice.settings.sensitivity = s.sensitivity < 0.1 ? 0.5 : Math.min(0.9, Math.max(0.2, s.sensitivity));
    }
  } catch {}
}

function saveSettings() {
  try { localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(Voice.settings)); } catch {}
}

// Called by settings.js whenever the user changes a voice setting
window.updateVoiceSettings = function () {
  const voiceSel = document.getElementById('voice-voice-setting');
  const sensSel  = document.getElementById('voice-sensitivity-setting');
  if (voiceSel) Voice.settings.voice = voiceSel.value;
  if (sensSel)  Voice.settings.sensitivity = parseFloat(sensSel.value);
  saveSettings();
  if (Voice.vad?.updateOptions) {
    try {
      Voice.vad.updateOptions({
        positiveSpeechThreshold: Voice.settings.sensitivity,
        negativeSpeechThreshold: Math.max(0.15, Voice.settings.sensitivity - 0.15),
      });
    } catch {}
  }
};

// ── Voice system prompt ───────────────────────────────────────────────────────

function buildVoiceSystemPrompt(courseId) {
  const courses = state.courses || {};
  const c = courseId && courses[courseId];
  const voiceRules = `VOICE MODE RULES:
- You are speaking aloud. Keep responses to 2-3 short sentences unless asked to go deeper.
- No markdown, no bullet points, no bold, no headings — just plain spoken prose.
- Use everyday language. Short sentences. Conversational rhythm.
- When explaining, start with the one-line gist, then a concrete example if useful.
- End with a brief follow-up question when it would keep the dialogue going.
- Never say "as an AI" or apologise for being a model.`;

  if (!c) return `You are Ricky's voice tutor for his May 2026 Bocconi exams.\n\n${voiceRules}`;

  const sessions = c.sessions.map(s => `- Session ${s.id}: ${s.title}`).join('\n');
  const keyTerms = (c.definitions || []).slice(0, 12).map(d => `- ${d.term}: ${d.definition}`).join('\n');
  return `You are Ricky's voice tutor for ${c.name} at Università Bocconi. Exam: ${c.exam_date} (${c.exam_format}).

SESSIONS:
${sessions}

KEY TERMS:
${keyTerms}

${voiceRules}`;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function setVoiceState(s) {
  Voice.state = s;
  const orb = document.getElementById('voice-orb');
  if (orb) orb.dataset.state = s;
}

function setVoiceStatus(msg) {
  const el = document.getElementById('voice-status');
  if (el) el.textContent = msg;
}

function appendVoiceTranscript(role, text) {
  const el = document.getElementById('voice-transcript');
  if (!el) return null;
  const line = document.createElement('div');
  line.className = 'voice-line voice-line-' + role;
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  return line;
}

function updateVoiceContinuingHint() {
  const el = document.getElementById('voice-continuing-hint');
  if (!el) return;
  if (!Voice.resumed || Voice.history.length === 0) { el.hidden = true; el.textContent = ''; return; }
  const turns = Voice.history.length;
  el.hidden = false;
  el.textContent = `Continuing — ${turns} previous message${turns === 1 ? '' : 's'}`;
}

// ── Audio ─────────────────────────────────────────────────────────────────────

function stopAllAudio() {
  if (Voice.audioPlaying) {
    try {
      Voice.audioPlaying.pause();
      if (typeof Voice.audioPlaying.onended === 'function') Voice.audioPlaying.onended();
      Voice.audioPlaying.src = '';
    } catch {}
  }
  Voice.audioPlaying = null;
}

function interruptSpeaking() {
  if (Voice.abortCtrl) { try { Voice.abortCtrl.abort(); } catch {} Voice.abortCtrl = null; }
  stopAllAudio();
  playChain = Promise.resolve();
  setVoiceState('listening');
  setVoiceStatus('Listening — go ahead');
}

// ── WAV encoder ───────────────────────────────────────────────────────────────

function encodePcmToWav(float32, sampleRate) {
  const numSamples = float32.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view   = new DataView(buffer);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── Sentence streaming ────────────────────────────────────────────────────────

function flushSentences(buf) {
  const sentences = [];
  const re = /[^.!?\n]+[.!?]+(?:\s|$)|[^.!?\n]+\n+/g;
  let m, lastIdx = 0;
  while ((m = re.exec(buf)) !== null) {
    const s = m[0].trim();
    if (s) sentences.push(s);
    lastIdx = re.lastIndex;
  }
  return { sentences, remainder: buf.slice(lastIdx) };
}

function enqueueTtsSentence(text) {
  const signal = Voice.abortCtrl?.signal;
  const ttsPromise = fetch('/api/tts/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: Voice.settings.voice }),
    signal,
  }).then(async r => {
    if (!r.ok) throw new Error('TTS failed');
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.dataset.url = url;
    return audio;
  });

  playChain = playChain.then(async () => {
    let audio;
    try { audio = await ttsPromise; } catch { return; }
    if (!Voice.abortCtrl || Voice.state === 'idle') {
      try { URL.revokeObjectURL(audio.dataset.url); } catch {}
      return;
    }
    if (!firstAudioStarted) { firstAudioStarted = true; setVoiceState('speaking'); setVoiceStatus('Speaking…'); }
    Voice.audioPlaying = audio;
    await new Promise(resolve => {
      audio.onended = () => { try { URL.revokeObjectURL(audio.dataset.url); } catch {} resolve(); };
      audio.onerror = () => { try { URL.revokeObjectURL(audio.dataset.url); } catch {} resolve(); };
      audio.play().catch(() => resolve());
    });
    Voice.audioPlaying = null;
  });
}

// ── Background summariser ─────────────────────────────────────────────────────

function maybeSummariseInBackground() {
  if (Voice.summarizing) return;
  const RECENT = 10;
  const unsummarised = Voice.history.length - (Voice.summarizedUpTo || 0);
  if (unsummarised <= RECENT) return;
  const upTo  = Voice.history.length - RECENT;
  const chunk = Voice.history.slice(Voice.summarizedUpTo || 0, upTo);
  if (!chunk.length) return;
  Voice.summarizing = true;
  const capturedConvId = Voice.convId;
  const priorSummary  = Voice.summary || '';
  fetch('/api/voice/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priorSummary, newMessages: chunk }),
  })
  .then(r => r.ok ? r.json() : Promise.reject(new Error('Summarise failed')))
  .then(data => {
    if (Voice.convId !== capturedConvId) return;
    if (data?.summary) { Voice.summary = data.summary; Voice.summarizedUpTo = upTo; }
  })
  .catch(err => console.warn('[Voice] Background summarise failed:', err.message))
  .finally(() => { Voice.summarizing = false; });
}

// ── Claude streaming reply ────────────────────────────────────────────────────

async function streamClaudeReply() {
  Voice.abortCtrl = new AbortController();
  playChain = Promise.resolve();
  firstAudioStarted = false;

  const RECENT = 10;
  let systemPrompt = buildVoiceSystemPrompt(Voice.courseId);
  let history;
  if (Voice.history.length <= RECENT) {
    history = Voice.history.slice();
  } else {
    history = Voice.history.slice(-RECENT);
    if (Voice.summary?.trim()) {
      systemPrompt += `\n\nCONVERSATION SO FAR (prior context, already discussed with Ricky):\n${Voice.summary.trim()}\n\nUse this as context — do not recap it back unless Ricky asks. Continue naturally from the recent exchanges below.`;
    }
  }

  const replyLine = appendVoiceTranscript('assistant', '');
  let fullText = '', sentenceBuffer = '', sentenceCount = 0;

  const res = await fetch('/api/voice/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: history,
    }),
    signal: Voice.abortCtrl.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Stream failed' }));
    throw new Error(err.error || 'Stream failed');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
      const eventBlock = sseBuffer.slice(0, idx);
      sseBuffer = sseBuffer.slice(idx + 2);
      const dataLine = eventBlock.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      try {
        const payload = JSON.parse(dataLine.slice(5).trim());
        if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
          const chunk = payload.delta.text || '';
          fullText += chunk;
          sentenceBuffer += chunk;
          if (replyLine) replyLine.textContent = fullText;
          const flushed = flushSentences(sentenceBuffer);
          sentenceBuffer = flushed.remainder;
          for (const s of flushed.sentences) { enqueueTtsSentence(s); sentenceCount++; }
        }
      } catch {}
    }
  }

  const tail = sentenceBuffer.trim();
  if (tail) { enqueueTtsSentence(tail); sentenceCount++; }

  Voice.history.push({ role: 'assistant', content: fullText });
  maybeSummariseInBackground();

  if (sentenceCount === 0) {
    Voice.abortCtrl = null;
    setVoiceState('listening');
    setVoiceStatus('Listening');
    return;
  }

  await playChain;
  Voice.abortCtrl = null;
  if (Voice.state === 'speaking' || Voice.state === 'thinking') {
    setVoiceState('listening');
    setVoiceStatus('Listening');
  }
}

// ── Utterance pipeline (STT → Claude → TTS) ──────────────────────────────────

async function sendUtterance(blob) {
  setVoiceState('thinking');
  setVoiceStatus('Transcribing…');
  try {
    const audio = await blobToBase64(blob);
    const sttRes = await fetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio, mimeType: blob.type || 'audio/wav' }),
    });
    const sttData = await sttRes.json();
    if (sttData.error) throw new Error(sttData.error);
    const userText = (sttData.text || '').trim();
    if (!userText) { setVoiceState('listening'); setVoiceStatus("Didn't catch that — try again"); return; }
    appendVoiceTranscript('user', userText);
    Voice.history.push({ role: 'user', content: userText });
    setVoiceStatus('Thinking…');
    await streamClaudeReply();
  } catch (err) {
    console.error('sendUtterance error:', err);
    setVoiceStatus('Error: ' + err.message);
    setVoiceState('listening');
  }
}

// ── Public API (window globals) ───────────────────────────────────────────────

window.openVoiceModal = async function () {
  if (!state.chat.courseContext) { alert('Pick a course first.'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { alert('Your browser does not support microphone access.'); return; }
  if (typeof window.vad === 'undefined' || !window.vad.MicVAD) {
    alert('Voice library (vad-web) not loaded. Check /vad/bundle.min.js and /ort/ort.wasm.min.js are reachable.');
    return;
  }
  if (typeof window.ort === 'undefined') {
    alert('onnxruntime-web not loaded. Check /ort/ort.wasm.min.js is reachable.');
    return;
  }

  loadSettings();
  Voice.courseId  = state.chat.courseContext;
  Voice.muted     = false;
  Voice.summarizing = false;

  const existing = (() => {
    if (!state.chat.currentConvId) return null;
    const data = loadChatData();
    return ((data.conversations || {})[Voice.courseId] || []).find(c => c.id === state.chat.currentConvId) || null;
  })();

  if (existing) {
    Voice.convId = existing.id;
    Voice.history = Array.isArray(existing.messages) ? existing.messages.slice() : [];
    Voice.summary = existing.summary || '';
    Voice.summarizedUpTo = Number.isFinite(existing.summarizedUpTo) ? existing.summarizedUpTo : 0;
    Voice.resumed = Voice.history.length > 0;
    Voice.origTitle   = existing.title || null;
    Voice.origCreated = existing.created || null;
  } else {
    Voice.convId = 'v-' + Date.now();
    Voice.history = []; Voice.summary = ''; Voice.summarizedUpTo = 0;
    Voice.resumed = false; Voice.origTitle = null; Voice.origCreated = null;
  }

  const modal = document.getElementById('voice-modal');
  modal.style.display = 'flex';
  requestAnimationFrame(() => modal.classList.add('open'));

  const transcriptEl = document.getElementById('voice-transcript');
  if (transcriptEl) {
    transcriptEl.innerHTML = '';
    if (Voice.resumed) {
      Voice.history.slice(-6).forEach(msg => appendVoiceTranscript(msg.role === 'user' ? 'user' : 'assistant', msg.content));
    }
  }
  updateVoiceContinuingHint();
  setVoiceStatus('Loading voice model…');
  setVoiceState('listening');

  try {
    Voice.vad = await window.vad.MicVAD.new({
      model: 'v5',
      positiveSpeechThreshold: Voice.settings.sensitivity,
      negativeSpeechThreshold: Math.max(0.15, Voice.settings.sensitivity - 0.15),
      redemptionFrames: 24,
      preSpeechPadFrames: 10,
      minSpeechFrames: 8,
      onnxWASMBasePath: '/ort/',
      baseAssetPath:    '/vad/',
      onSpeechStart: () => {
        if (Voice.muted) return;
        if (Voice.state === 'speaking') interruptSpeaking();
        else if (Voice.state === 'listening') setVoiceStatus('Listening…');
      },
      onSpeechEnd: (audio) => {
        if (Voice.muted || Voice.state !== 'listening') return;
        sendUtterance(encodePcmToWav(audio, 16000));
      },
      onVADMisfire: () => {
        if (Voice.state === 'listening') setVoiceStatus('Too short — try again');
      },
    });
    Voice.vad.start();
    setVoiceStatus('Listening — go ahead');
  } catch (err) {
    console.error('[VAD] Init failed:', err);
    setVoiceStatus('Mic error: ' + (err.message || 'failed to start'));
    alert('Could not start voice mode:\n\n' + (err?.message || String(err)) + '\n\nCheck browser console for details.');
    window.closeVoiceModal();
  }
};

window.closeVoiceModal = function () {
  stopAllAudio();
  if (Voice.abortCtrl) { try { Voice.abortCtrl.abort(); } catch {} Voice.abortCtrl = null; }
  if (Voice.vad) { try { Voice.vad.pause(); Voice.vad.destroy(); } catch {} Voice.vad = null; }
  const hint = document.getElementById('voice-continuing-hint');
  if (hint) { hint.hidden = true; hint.textContent = ''; }

  if (Voice.history.length > 0 && Voice.courseId) {
    const data = loadChatData();
    if (!data.conversations[Voice.courseId]) data.conversations[Voice.courseId] = [];
    const list = data.conversations[Voice.courseId];
    const idx  = list.findIndex(c => c.id === Voice.convId);
    if (idx >= 0) {
      Object.assign(list[idx], { messages: Voice.history.slice(), summary: Voice.summary || '', summarizedUpTo: Voice.summarizedUpTo || 0, mode: 'voice', draft: false, updated: Date.now() });
    } else {
      const firstUser = Voice.history.find(m => m.role === 'user');
      const title = firstUser
        ? (firstUser.content.slice(0, 45) + (firstUser.content.length > 45 ? '…' : ''))
        : 'Voice chat';
      list.push({ id: Voice.convId, title: Voice.origTitle || ('🎙 ' + title), created: Voice.origCreated || Date.now(), updated: Date.now(), draft: false, mode: 'voice', summary: Voice.summary || '', summarizedUpTo: Voice.summarizedUpTo || 0, messages: Voice.history.slice() });
    }
    saveChatData(data);
    if (state.chat.currentConvId === Voice.convId) state.chat.history = Voice.history.slice();
  }

  const modal = document.getElementById('voice-modal');
  modal.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 200);

  Voice.state = 'idle'; Voice.history = []; Voice.summary = ''; Voice.summarizedUpTo = 0;
  Voice.resumed = false; Voice.courseId = null; Voice.convId = null;
  Voice.origTitle = null; Voice.origCreated = null;
};

window.toggleVoiceMute = function () {
  Voice.muted = !Voice.muted;
  const btn = document.getElementById('voice-mute-btn');
  if (btn) btn.classList.toggle('muted', Voice.muted);
  setVoiceStatus(Voice.muted ? 'Muted' : (Voice.state === 'listening' ? 'Listening' : 'Speaking…'));
};
