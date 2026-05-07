import { escapeHtml } from '../../lib/utils.js';
import { state } from '../../store/store.js';
import {
  loadOrbitChatHistory,
  clearOrbitChatHistory,
  streamOrbitChat,
  loadStudyOrbit,
} from '../../lib/api.js';
import { showToast } from '../../lib/toast.js';
import { on, off, emit } from '../../store/store.js';

function _renderMessages() {
  const panel = document.getElementById('orbit-chat-panel');
  if (!panel) return;
  const container = panel.querySelector('.orbit-chat-messages');
  if (!container) return;

  const msgs = state.orbitChat.messages;

  const renderMsg = m => {
    let bubble = `<div class="orbit-chat-bubble">${escapeHtml(m.content)}</div>`;

    if (m.proposal) {
      const isPending   = m.proposal.pending;
      const isApproved  = m.proposal.approved;
      const stepsHtml   = (m.proposal.steps || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');
      const statusBadge = !isPending
        ? `<div class="orbit-proposal-status ${isApproved ? 'approved' : 'rejected'}">${isApproved ? 'Applied' : 'Cancelled'}</div>`
        : '';
      const fillPicker = isPending && m.proposal.fill_mode_required
        ? `<div class="orbit-fill-mode-picker">
            <label class="orbit-fill-mode-label">What do you want to do next?</label>
            <select class="orbit-fill-mode-select" id="orbit-fill-mode-select">
              <option value="">Choose…</option>
              <option value="consolidate">Review this lecture — quiz + consolidate now (first pass marked done)</option>
              <option value="progress">Next lecture in this subject — I'm done with this one</option>
              <option value="switch">Switch subjects — I'm done with this lecture, do something else</option>
            </select>
          </div>`
        : '';
      const applyDisabled = isPending && m.proposal.fill_mode_required ? ' disabled' : '';
      const actions = isPending
        ? `<div class="orbit-proposal-actions">
            ${fillPicker}
            <div class="orbit-proposal-btns">
              <button class="orbit-proposal-btn apply" id="orbit-proposal-apply"${applyDisabled}>Apply</button>
              <button class="orbit-proposal-btn cancel" id="orbit-proposal-cancel">Cancel</button>
            </div>
          </div>`
        : '';

      bubble = `
        <div class="orbit-chat-bubble">${m.content ? escapeHtml(m.content) : ''}</div>
        <div class="orbit-proposal-card${isPending ? '' : ' resolved'}">
          <div class="orbit-proposal-title">Proposed changes</div>
          <ul class="orbit-proposal-steps">${stepsHtml}</ul>
          ${statusBadge}
          ${actions}
        </div>`;
    }

    return `<div class="orbit-chat-msg ${m.role}">${bubble}</div>`;
  };

  container.innerHTML = msgs.length === 0 && !state.orbitChat.loading
    ? `<div class="orbit-chat-empty">Ask Orbit to reschedule tasks, adjust your day, or explain your plan.</div>`
    : msgs.map(renderMsg).join('') + (state.orbitChat.loading
        ? `<div class="orbit-chat-msg assistant">
             <div class="orbit-chat-bubble orbit-chat-loading">
               <span></span><span></span><span></span>
               <span class="orbit-chat-loading-label">${escapeHtml(state.orbitChat.loadingLabel || 'Thinking…')}</span>
             </div>
           </div>`
        : '');

  container.scrollTop = container.scrollHeight;
}

function _onLoadingLabel() {
  const el = document.querySelector('.orbit-chat-loading-label');
  if (el) el.textContent = (state.orbitChat.loadingLabel || 'Thinking…') + '…';
}

async function _sendMessage(text) {
  if (!text || state.orbitChat.loading) return;

  state.orbitChat.messages.push({ role: 'user', content: text, ts: Date.now() });
  state.orbitChat.loading = true;
  state.orbitChat.loadingLabel = 'Thinking…';
  _renderMessages();

  try {
    const result = await streamOrbitChat({ message: text, snapshot: state.orbit.data });

    if (result.proposal) {
      state.orbitChat.pendingProposal = { ...result.proposal, selectedFillMode: null };
      state.orbitChat.messages.push({
        role: 'assistant',
        content: result.proposal.explanation || '',
        ts: Date.now(),
        proposal: { steps: result.proposal.steps, tools: result.proposal.tools, fill_mode_required: result.proposal.fill_mode_required || false, pending: true },
      });
    } else {
      state.orbitChat.messages.push({ role: 'assistant', content: result.reply || 'Done.', ts: Date.now() });
      if (result.mutated) {
        await loadStudyOrbit(true, true);
        showToast('Calendar updated');
      }
    }
  } catch (err) {
    state.orbitChat.messages.push({ role: 'assistant', content: 'Something went wrong — try again.', ts: Date.now() });
  } finally {
    state.orbitChat.loading = false;
    state.orbitChat.loadingLabel = '';
    _renderMessages();
  }
}

async function _confirmProposal(approved) {
  const proposal = state.orbitChat.pendingProposal;
  if (!proposal) return;

  state.orbitChat.pendingProposal = null;
  const proposalMsg = [...state.orbitChat.messages].reverse().find(m => m.proposal?.pending);
  if (proposalMsg) proposalMsg.proposal = { ...proposalMsg.proposal, pending: false, approved };

  if (!approved) {
    state.orbitChat.messages.push({ role: 'assistant', content: 'No changes made.', ts: Date.now() });
    _renderMessages();
    return;
  }

  state.orbitChat.loading = true;
  state.orbitChat.loadingLabel = 'Applying changes…';
  _renderMessages();

  try {
    const toolsToSend = (proposal.tools || []).map(t =>
      t.name === 'replace_today' && proposal.selectedFillMode
        ? { ...t, input: { ...t.input, fill_mode: proposal.selectedFillMode } }
        : t
    );
    const result = await streamOrbitChat({ message: '[confirmed]', confirmTools: toolsToSend, snapshot: state.orbit.data });
    state.orbitChat.messages.push({ role: 'assistant', content: result.reply || 'Done.', ts: Date.now() });
    if (result.mutated) {
      state.orbit.weekOffset = 0;
      await loadStudyOrbit(true, true);
      emit('orbit:data');
      showToast('Calendar updated');
    }
  } catch (err) {
    state.orbitChat.messages.push({ role: 'assistant', content: 'Something went wrong applying changes — try again.', ts: Date.now() });
  } finally {
    state.orbitChat.loading = false;
    state.orbitChat.loadingLabel = '';
    _renderMessages();
  }
}

export function mountChat(orbitContainer) {
  const existing = document.getElementById('orbit-chat-panel');
  if (existing) return; // already mounted

  const wrapper = document.createElement('div');
  wrapper.id = 'orbit-chat-wrapper';
  wrapper.innerHTML = `
    <button id="orbit-chat-fab" class="orbit-chat-fab" title="Chat with Orbit" aria-label="Open Orbit chat">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
    </button>
    <div id="orbit-chat-panel" class="orbit-chat-panel">
      <div class="orbit-chat-header">
        <div>
          <strong>Orbit</strong>
          <span>Your study agent</span>
        </div>
        <div style="display:flex;gap:0.25rem;align-items:center">
          <button id="orbit-chat-clear" class="orbit-chat-close" title="Clear conversation">↺</button>
          <button id="orbit-chat-close" class="orbit-chat-close" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="orbit-chat-messages"></div>
      <div class="orbit-chat-input-row">
        <textarea id="orbit-chat-input"
          placeholder="Bad sleep, move my morning tasks…"
          rows="1"></textarea>
        <button id="orbit-chat-send" class="orbit-chat-send" aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
    </div>`;

  orbitContainer.appendChild(wrapper);

  const fab     = document.getElementById('orbit-chat-fab');
  const panel   = document.getElementById('orbit-chat-panel');
  const closeBtn = document.getElementById('orbit-chat-close');
  const clearBtn = document.getElementById('orbit-chat-clear');
  const sendBtn  = document.getElementById('orbit-chat-send');
  const input    = document.getElementById('orbit-chat-input');

  function _toggle() {
    state.orbitChat.open = !state.orbitChat.open;
    panel.classList.toggle('open', state.orbitChat.open);
    fab.classList.toggle('active', state.orbitChat.open);
    if (state.orbitChat.open) {
      loadOrbitChatHistory().then(_renderMessages);
      setTimeout(() => {
        const msgs = panel.querySelector('.orbit-chat-messages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      }, 50);
    }
  }

  fab.addEventListener('click', _toggle);
  closeBtn.addEventListener('click', _toggle);
  clearBtn.addEventListener('click', () => clearOrbitChatHistory().then(_renderMessages));
  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    input.value = '';
    input.style.height = '';
    _sendMessage(text);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  });
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // Proposal button delegation (panel)
  panel.addEventListener('click', e => {
    if (e.target.id === 'orbit-proposal-apply') _confirmProposal(true);
    if (e.target.id === 'orbit-proposal-cancel') _confirmProposal(false);
    if (e.target.id === 'orbit-fill-mode-select') return; // let change handle it
  });
  panel.addEventListener('change', e => {
    if (e.target.id === 'orbit-fill-mode-select') {
      const val = e.target.value;
      if (state.orbitChat.pendingProposal) state.orbitChat.pendingProposal.selectedFillMode = val || null;
      const applyBtn = document.getElementById('orbit-proposal-apply');
      if (applyBtn) applyBtn.disabled = !val;
    }
  });

  on('orbit:chat:messages', _renderMessages);
  on('orbit:chat:loading-label', _onLoadingLabel);

  // Restore open state if it was open before re-render
  if (state.orbitChat.open) {
    panel.classList.add('open');
    fab.classList.add('active');
    _renderMessages();
  }
}

export function unmountChat() {
  off('orbit:chat:messages', _renderMessages);
  off('orbit:chat:loading-label', _onLoadingLabel);
  const wrapper = document.getElementById('orbit-chat-wrapper');
  if (wrapper) wrapper.remove();
}
