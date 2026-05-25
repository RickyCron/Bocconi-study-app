import { state } from '../../store/store.js';
import { navigate } from '../../router.js';
import {
  loadChatData, saveChatData, saveCurrentConv, cleanupDraft,
} from '../../lib/api.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { escapeHtml } from '../../lib/utils.js';
import { COURSES, MODELS } from '../../config.js';

// ── Course sidebar colors (mirrors CSS vars) ──────────────────────────────────

const COURSE_COLOR = {
  gtm: 'var(--c-gtm)', geopolitics: 'var(--c-geo)',
  digital_strategy: 'var(--c-ds)', ibm: 'var(--c-ibm)', ism: 'var(--c-ism)',
};

const COURSE_SIDEBAR = COURSES.map(c => ({
  id: c.id, name: c.name, color: COURSE_COLOR[c.id] || 'var(--t3)',
  date: new Date(c.examDate + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
}));

// ── Memory helpers ────────────────────────────────────────────────────────────

function updateMemory(courseId) {
  if (!courseId || state.chat.history.length === 0) return;
  const data = loadChatData();
  if (!data.memory[courseId]) data.memory[courseId] = { sessionCount: 0, lastTopic: '', struggles: [] };
  const mem = data.memory[courseId];
  mem.sessionCount = (mem.sessionCount || 0) + 1;
  const firstUser = state.chat.history.find(m => m.role === 'user');
  if (firstUser) {
    const text = Array.isArray(firstUser.content)
      ? (firstUser.content.find(b => b.type === 'text')?.text || '')
      : firstUser.content;
    mem.lastTopic = text.slice(0, 60);
  }
  saveChatData(data);
}

function getWeakTopics(courseId) {
  if (!courseId) return [];
  const questions = (state.questions || {})[courseId] || [];
  const sessions  = ((state.courses  || {})[courseId] || {}).sessions || [];
  const sessionMap = {};
  sessions.forEach(s => { sessionMap[s.id] = s.title; });
  const weakSessions = new Set();
  for (const q of questions) {
    const p = (state.progress || {})[q.id];
    if (p && p.attempts > 0 && (p.correct / p.attempts) < 0.6) {
      const label = q.session ? (sessionMap[q.session] || q.session) : null;
      if (label) weakSessions.add(label);
    }
  }
  return [...weakSessions].slice(0, 3);
}

function getSmartSuggestions(courseId) {
  const weak = getWeakTopics(courseId);
  const data = loadChatData();
  const mem  = (data.memory[courseId] || {});
  const sessions = ((state.courses || {})[courseId] || {}).sessions || [];
  if (weak.length > 0) {
    return [`Help me understand ${weak[0]}`, 'Quiz me on my weak areas', "What's most likely on the exam?"];
  }
  if ((mem.sessionCount || 0) === 0) {
    const first = sessions[0];
    return [first ? `Walk me through ${first.title}` : 'Give me an overview', 'Quiz me on the basics', "What's the exam format and what matters most?"];
  }
  return [
    mem.lastTopic ? `Continue from last time — ${mem.lastTopic.slice(0, 30)}` : 'Continue where we left off',
    'Quiz me on something I might have missed',
    "What's most important to nail before the exam?",
  ];
}

// ── User display name ─────────────────────────────────────────────────────────

function userName() {
  const u = state.user || 'there';
  return u.charAt(0).toUpperCase() + u.slice(1);
}

// ── Greeting ──────────────────────────────────────────────────────────────────

function buildGreetingHtml(courseId) {
  const course = (state.courses || {})[courseId];
  const data  = loadChatData();
  const mem   = data.memory[courseId] || {};
  const weak  = getWeakTopics(courseId);
  const suggestions = getSmartSuggestions(courseId);
  const sessionCount = mem.sessionCount || 0;

  let html = '';
  if (sessionCount === 0) {
    html += `<span class="md-p">Hey ${escapeHtml(userName())}! I've got your <strong>${course ? escapeHtml(course.name) : 'course'}</strong> notes and exam format loaded. Let's get to work.</span>`;
  } else {
    html += `<span class="md-p">Hey ${escapeHtml(userName())}, session ${sessionCount + 1} for <strong>${course ? escapeHtml(course.name) : 'this course'}</strong>.`;
    if (mem.lastTopic) html += ` Last time we covered <strong>${escapeHtml(mem.lastTopic)}</strong>.`;
    html += `</span>`;
  }
  if (weak.length > 0) {
    html += `<span class="md-p" style="margin-top:0.5rem;">Your quiz results flag these as worth revisiting:</span>`;
    html += `<ul class="md-list">${weak.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
  }
  html += `<span class="md-p" style="color:var(--t2);margin-top:0.625rem;">Where do you want to start?</span>`;
  html += `<div class="greeting-prompts">${suggestions.map(s => `<button class="greeting-pill" data-send="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>`;
  return html;
}

// ── System prompts ────────────────────────────────────────────────────────────

function buildTutorSystemPrompt(courseId) {
  const courses = state.courses || {};
  if (courseId && courses[courseId]) {
    const c = courses[courseId];
    const sessions = c.sessions.map(s => `  - Session ${s.id}: ${s.title}\n    Topics: ${s.topics.join(' | ')}`).join('\n');
    const defs = (c.definitions || []).map(d => `  - ${d.term}: ${d.definition}`).join('\n');
    const concepts = (c.concepts || []).map(k => `  - ${k.name}: ${k.explanation}`).join('\n');
    const distinctions = (c.distinctions || []).map(d => `  - ${d.a} vs ${d.b}: ${d.difference}`).join('\n');
    const examples = (c.examples || []).map(e => `  - ${typeof e === 'string' ? e : `${e.name}: ${e.description}`}`).join('\n');
    const keywords = (c.keywords || []).join(', ');
    const chatData = loadChatData();
    const mem = chatData.memory[courseId] || {};
    const weakTopics = getWeakTopics(courseId);
    let memCtx = '';
    if (mem.sessionCount > 0 || weakTopics.length > 0) {
      memCtx += '\n\nSTUDENT CONTEXT:';
      if (mem.sessionCount > 0) memCtx += `\n- This is session ${mem.sessionCount + 1} with ${userName()} for this course.`;
      if (mem.lastTopic) memCtx += `\n- Last session topic: "${mem.lastTopic}"`;
      if (weakTopics.length > 0) memCtx += `\n- Quiz weak areas: ${weakTopics.join(', ')}`;
      memCtx += '\n\nUse this context — do not re-introduce yourself. Pick up naturally. Prioritise weak areas if relevant.';
    }
    return `You are an expert tutor for ${userName()}, a student at Università Bocconi in Milan studying for their May 2026 exams.

COURSE: ${c.name}
EXAM DATE: ${c.exam_date}
EXAM FORMAT: ${c.exam_format}

━━ COURSE MATERIALS — YOUR ONLY SOURCE OF TRUTH ━━

SESSIONS (in order):
${sessions}

KEY DEFINITIONS:
${defs || 'None listed.'}

KEY CONCEPTS:
${concepts || 'None listed.'}

KEY DISTINCTIONS:
${distinctions || 'None listed.'}

KEY EXAMPLES FROM THE COURSE:
${examples || 'None listed.'}

KEYWORDS:
${keywords || 'None listed.'}

━━ GROUNDING RULES — FOLLOW EXACTLY ━━
- ONLY teach from the materials above. Every explanation must trace back to something listed here.
- Do NOT introduce frameworks, models, tools, statistics, or examples that are not named in the materials above — even if you know them from general knowledge.
- Walk through sessions in the order they appear above unless ${userName()} asks otherwise.
- If asked about something not covered in these materials, say: "That's not in your course notes for this exam. Want me to stick to what's examinable, or explain it from general knowledge?"
- When explaining a concept, use the EXACT wording and framing from the materials above — do not substitute your own version or paraphrase with synonyms.
- If you are not certain something is in the materials, do not say it.

YOUR ROLE:
- Teach like a human tutor having a conversation — not like a textbook or Wikipedia.
- Lead with the core idea in plain English, then add nuance. Short paragraphs, not lists.
- When something is subtle or commonly confused, slow down and explain the *why*.
- For wrong answers: say exactly which part of the thinking is off and why the right answer holds.
- For MCQ courses (GTM, Geopolitics, IBM): be alert to the "which is NOT correct" trap — help the student spot the false statement quickly.
- For ISM: coach the student on building a structured answer, not just recalling facts.
- End with a follow-up question or small challenge when it would help cement the concept.
- Use **bold** for key terms. Avoid walls of bullet points — prose is warmer and sticks better.
- If asked to quiz, generate 3–5 questions in the exact exam format for this course.${memCtx}`;
  }
  const courseList = Object.values(state.courses || {}).map(c => `- ${c.name} (${c.exam_date}, ${c.exam_format})`).join('\n');
  return `You are ${userName()}'s personal tutor for their May 2026 Bocconi exams:\n${courseList}\n\nTeach conversationally — like a tutor in the room, not a textbook. Lead with the core idea in plain English. Use short paragraphs and **bold** for key terms. Avoid walls of bullet points. Explain *why* things are true, not just *what* they are. End with a follow-up question when it helps cement the concept.`;
}

function buildNotesSystemPrompt(courseId) {
  const courses = state.courses || {};
  const c = courseId && courses[courseId];
  const sessionList = c ? c.sessions.map(s => `  - Session ${s.id}: ${s.title}\n    Topics: ${s.topics.join(' | ')}`).join('\n') : 'All courses';
  const defs = c ? (c.definitions || []).map(d => `  - ${d.term}: ${d.definition}`).join('\n') : '';
  const concepts = c ? (c.concepts || []).map(k => `  - ${k.name}: ${k.explanation}`).join('\n') : '';
  const distinctions = c ? (c.distinctions || []).map(d => `  - ${d.a} vs ${d.b}: ${d.difference}`).join('\n') : '';
  const examples = c ? (c.examples || []).map(e => `  - ${typeof e === 'string' ? e : `${e.name}: ${e.description}`}`).join('\n') : '';
  const keywords = c ? (c.keywords || []).join(', ') : '';
  const courseBlock = c
    ? `COURSE: ${c.name}\nEXAM DATE: ${c.exam_date}\nEXAM FORMAT: ${c.exam_format}\n\n━━ COURSE MATERIALS — YOUR ONLY SOURCE OF TRUTH ━━\n\nSESSIONS (in order):\n${sessionList}\n\nDEFINITIONS:\n${defs || 'None listed.'}\n\nCONCEPTS:\n${concepts || 'None listed.'}\n\nDISTINCTIONS:\n${distinctions || 'None listed.'}\n\nEXAMPLES:\n${examples || 'None listed.'}\n\nKEYWORDS:\n${keywords || 'None listed.'}\n\n━━ GROUNDING RULES ━━\n- ONLY use information from the materials above — no outside knowledge, frameworks, or examples.\n- Notes must reflect what is in the course, not general academic knowledge.\n- If something asked about is not in these materials, flag it: "That's not in your course notes — do you want to include it anyway or skip it?"`
    : 'All Bocconi May 2026 courses.';
  return `You are ${userName()}'s collaborative note-writing partner. Your job is NOT to lecture — it is to help ${userName()} write their own notes in their own words, so they actually stick.

${courseBlock}

HOW TO RUN THE SESSION:
1. Ask which session or topic they want to cover (offer a numbered list from the sessions above).
2. For each topic: ask them to explain it in their own words first. Then refine their explanation — fix gaps, sharpen phrasing, catch misconceptions. Do NOT just give them the answer unprompted.
3. After refining 2–3 points, show a "Notes so far" block — clean markdown, structured as they would write it for revision.
4. Keep going until the topic feels complete, then ask if they want to add depth or move on.
5. When they say "done", "finished" or "show full notes": output the complete final notes under a ## Final Notes heading, formatted as clean markdown suitable for copying.

STYLE RULES FOR THE NOTES YOU HELP THEM BUILD:
- Concise bullet points or short paragraphs — exam-answer ready, not a textbook dump
- **Bold** key terms. No fluff.
- For MCQ courses (GTM, Geopolitics, IBM): include a "Common traps" subsection flagging NOT-correct pitfalls
- For ISM: structure answers as: definition → mechanism → example → limitation
- Use ${userName()}'s own words wherever possible — only polish, don't replace

TONE: Direct. Like a study partner who knows the material cold and won't let them get away with vague answers. Push them to be precise.

VIDEO LINKS:
When a concept would genuinely click better with a visual — a diagram, a mechanism, a historical sequence, an abstract framework — include one YouTube search link inline using this exact markdown format:
[▶ Watch: {short description}](https://www.youtube.com/results?search_query={url-encoded+query})

Rules:
- Write the query in plain English, specific to the concept: e.g. "Porter Five Forces explained", "Ansoff matrix growth strategy", "comparative advantage international trade"
- Encode spaces as + in the URL
- Drop the link naturally inside your explanation — not as a separate section
- One link per message at most
- Only include it when a visual would genuinely add something text can't — skip it for straightforward definitions or simple facts

Start by asking which session/topic to cover. Offer the list. Do not start lecturing until they pick one and you've heard what they already know.`;
}

// ── Thinking roulette ─────────────────────────────────────────────────────────

function buildRoulettePhases(courseId, sessionId) {
  const course = (state.courses || {})[courseId];
  if (!course) {
    return [
      'Reading course notes…', 'Checking exam format…', 'Pulling key concepts…',
      'Thinking through this…', 'Connecting the dots…', 'Preparing explanation…',
    ];
  }
  const phases = [];

  if (sessionId) {
    // Only show slides for the active session
    const session = course.sessions.find(s => s.id === sessionId);
    for (const sl of (session?.slides || [])) phases.push(`Reading ${sl.title}…`);
  }

  // Always include the structured data counts
  const defCount  = (course.definitions  || []).length;
  const conCount  = (course.concepts     || []).length;
  const distCount = (course.distinctions || []).length;
  const exCount   = (course.examples     || []).length;
  if (defCount)  phases.push(`Checking ${defCount} definitions…`);
  if (conCount)  phases.push(`Scanning ${conCount} key concepts…`);
  if (distCount) phases.push(`Reviewing ${distCount} distinctions…`);
  if (exCount)   phases.push(`Pulling ${exCount} course examples…`);
  phases.push('Thinking through this…', 'Connecting the dots…', 'Preparing explanation…');
  return phases;
}

function startThinkingRoulette(textEl, courseId, sessionId) {
  const phases = buildRoulettePhases(courseId, sessionId);
  let i = 0;
  function setPhase(idx) {
    textEl.classList.remove('slide-in');
    void textEl.offsetWidth;
    textEl.textContent = phases[idx];
    textEl.classList.add('slide-in');
  }
  setPhase(0);
  return setInterval(() => { i = (i + 1) % phases.length; setPhase(i); }, 1500);
}

// ── File attachment handling ──────────────────────────────────────────────────

function _renderAttachmentPreview(container) {
  const preview = container.querySelector('#file-attachment-preview');
  if (!preview) return;
  if (state.chat.pendingAttachments.length === 0) {
    preview.style.display = 'none';
    preview.innerHTML = '';
    return;
  }
  preview.style.display = 'flex';
  preview.innerHTML = state.chat.pendingAttachments.map((att, i) => `
    <div class="attachment-chip">
      ${att.previewUrl
        ? `<img src="${att.previewUrl}" class="attachment-thumb" alt="${escapeHtml(att.name)}">`
        : `<svg class="attachment-icon" viewBox="0 0 16 16" fill="none"><path d="M3 2h7l3 3v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.25"/><path d="M10 2v4h3" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`}
      <span class="attachment-name">${escapeHtml(att.name)}</span>
      <button class="attachment-remove" data-remove="${i}" aria-label="Remove">
        <svg viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>`).join('');
}

function _renderUserMsgEl(content) {
  const el = document.createElement('div');
  el.className = 'chat-msg chat-msg-user';
  if (Array.isArray(content)) {
    let html = '';
    content.filter(b => b.type === 'image').forEach(b => {
      html += `<img src="data:${b.source.media_type};base64,${b.source.data}" class="chat-thumb" alt="image">`;
    });
    content.filter(b => b.type === 'document').forEach(() => {
      html += `<span class="chat-doc-chip"><svg viewBox="0 0 12 12" fill="none" style="width:.75rem;height:.75rem;flex-shrink:0;"><path d="M2 1h5l3 3v7H2V1z" stroke="currentColor" stroke-width="1.2"/></svg>PDF</span>`;
    });
    const textBlock = content.find(b => b.type === 'text');
    if (textBlock) html += `<div class="chat-attach-text">${escapeHtml(textBlock.text)}</div>`;
    el.innerHTML = html;
  } else {
    el.textContent = content;
  }
  return el;
}

// ── Session context (which lecture's PDFs to load) ────────────────────────────

let _sessionContext = null; // session ext_id currently being studied, e.g. "1-3"

function _setSessionContext(container, sessionId) {
  _sessionContext = sessionId;
  _updateSources(container, state.chat.courseContext);
}

// Try to detect a session from the sent message text, e.g. "Session 1-3: The Business Idea"
function _detectSession(msg, courseId) {
  if (!msg || !courseId) return null;
  const sessions = ((state.courses || {})[courseId] || {}).sessions || [];
  const m = msg.match(/[Ss]ession\s+([\w-]+)/);
  if (!m) return null;
  const hit = sessions.find(s => String(s.id) === m[1]);
  return hit ? hit.id : null;
}

// ── sendChat (exposed globally) ───────────────────────────────────────────────

function _sendChat(container, preset = null) {
  const input = container.querySelector('#chat-input');
  const msg   = preset || (input ? input.value.trim() : '');
  const attachments = state.chat.pendingAttachments.slice();
  if (!msg && attachments.length === 0) return;
  if (input) { input.value = ''; input.style.height = ''; }

  let userContent;
  if (attachments.length > 0) {
    userContent = [];
    for (const att of attachments) {
      if (att.mediaType.startsWith('image/')) {
        userContent.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.data } });
      } else if (att.mediaType === 'application/pdf') {
        userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: att.data }, cache_control: { type: 'ephemeral' } });
      } else if (att.mediaType === 'text/plain') {
        userContent.push({ type: 'text', text: `[Attached file: ${att.name}]\n\n${att.text}` });
      }
    }
    if (msg) userContent.push({ type: 'text', text: msg });
  } else {
    userContent = msg;
  }

  state.chat.pendingAttachments = [];
  _renderAttachmentPreview(container);

  // Detect and lock in session context from the message (e.g. "Session 1-3: …")
  if (msg) {
    const detected = _detectSession(msg, state.chat.courseContext);
    if (detected && detected !== _sessionContext) _setSessionContext(container, detected);
  }

  const msgArea = container.querySelector('#chat-messages');
  if (!msgArea) return;

  if (!state.chat.currentConvId && state.chat.courseContext) {
    state.chat.currentConvId = 'c-' + Date.now();
  }

  msgArea.appendChild(_renderUserMsgEl(userContent));
  msgArea.scrollTop = msgArea.scrollHeight;
  state.chat.history.push({ role: 'user', content: userContent });

  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'chat-msg chat-msg-ai thinking-roulette';
  const dot = document.createElement('span');
  dot.className = 'thinking-dot';
  const textSpan = document.createElement('span');
  textSpan.className = 'thinking-text';
  thinkingEl.appendChild(dot);
  thinkingEl.appendChild(textSpan);
  msgArea.appendChild(thinkingEl);
  msgArea.scrollTop = msgArea.scrollHeight;
  const rouletteTimer = startThinkingRoulette(textSpan, state.chat.courseContext, _sessionContext);

  let systemPrompt;
  try {
    systemPrompt = state.chat.notesMode
      ? buildNotesSystemPrompt(state.chat.courseContext)
      : buildTutorSystemPrompt(state.chat.courseContext);
  } catch (e) {
    clearInterval(rouletteTimer);
    thinkingEl.remove();
    const err = document.createElement('div');
    err.className = 'chat-msg chat-msg-ai';
    err.textContent = '⚠ Failed to build context: ' + e.message;
    msgArea.appendChild(err);
    return;
  }

  function buildApiMessages(history) {
    const hasValidData = b => (b.type === 'document' || b.type === 'image') && b.source?.data && b.source.data !== '[stripped]';
    const lastAttachIdx = history.reduceRight((found, m, i) => {
      if (found !== -1) return found;
      if (Array.isArray(m.content) && m.content.some(hasValidData)) return i;
      return -1;
    }, -1);
    return history.map((m, i) => {
      if (!Array.isArray(m.content)) return m;
      if (i === lastAttachIdx) {
        const validContent = m.content.filter(b => !((b.type === 'document' || b.type === 'image') && b.source?.data === '[stripped]'));
        return { ...m, content: validContent };
      }
      const textBlocks = m.content.filter(b => b.type !== 'document' && b.type !== 'image');
      const hadAttachment = textBlocks.length < m.content.length;
      if (!hadAttachment) return m;
      if (textBlocks.length === 0) return { ...m, content: '[shared a document]' };
      return { ...m, content: textBlocks.length === 1 ? textBlocks[0].text : textBlocks };
    });
  }

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      courseId: state.chat.courseContext || undefined,
      sessionId: _sessionContext || undefined,
      model: state.chat.model,
      max_tokens: 1500,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: buildApiMessages(state.chat.history),
    }),
  })
  .then(r => r.json())
  .then(data => {
    clearInterval(rouletteTimer);
    thinkingEl.remove();
    if (data.error) {
      const errMsg = typeof data.error === 'object' ? (data.error.message || JSON.stringify(data.error)) : data.error;
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-ai';
      el.textContent = '⚠ ' + errMsg;
      msgArea.appendChild(el);
      return;
    }
    const reply = data.content?.[0]?.text;
    if (!reply) {
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-ai';
      el.textContent = '⚠ No response received. Check the server logs.';
      msgArea.appendChild(el);
      return;
    }
    state.chat.history.push({ role: 'assistant', content: reply });
    const replyEl = document.createElement('div');
    replyEl.className = 'chat-msg chat-msg-ai';
    replyEl.innerHTML = renderMarkdown(reply);
    msgArea.appendChild(replyEl);
    msgArea.scrollTop = msgArea.scrollHeight;
    saveCurrentConv();
    _renderSidebar(container);
  })
  .catch(err => {
    clearInterval(rouletteTimer);
    thinkingEl.remove();
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-ai';
    el.textContent = '⚠ Network error: ' + err.message;
    msgArea.appendChild(el);
  });
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function fmtConvDate(ts) {
  const d = new Date(ts);
  const diffDays = Math.floor((Date.now() - d) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7)  return `${diffDays}d ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function _renderSidebar(container) {
  const sidebarEl = container.querySelector('#tutor-sidebar');
  if (!sidebarEl) return;
  const data    = loadChatData();
  const cur     = state.chat.courseContext;
  const curConv = state.chat.currentConvId;
  let html = `<div class="tutor-sidebar-hd">Courses</div>`;

  for (const c of COURSE_SIDEBAR) {
    const isSelected = cur === c.id;
    const convs = (data.conversations[c.id] || []).slice().sort((a, b) => b.updated - a.updated);
    html += `
      <div class="course-section">
        <button class="course-btn${isSelected ? ' active' : ''}" data-action="select-course" data-course="${c.id}">
          <div class="course-btn-top">
            <span class="course-btn-dot" style="background:${c.color}"></span>
            <span class="course-btn-name">${escapeHtml(c.name)}</span>
          </div>
          <span class="course-btn-date">${c.date}</span>
        </button>`;

    if (isSelected) {
      html += `<div class="conv-list">
        <button class="conv-new" data-action="new-chat" data-course="${c.id}">
          <svg viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke-linecap="round"/></svg>
          New chat
        </button>`;
      for (const conv of convs) {
        const active  = conv.id === curConv ? ' active' : '';
        const isDraft = conv.draft ? ' draft' : '';
        const cid = escapeHtml(c.id);
        const vid = escapeHtml(conv.id);
        html += `<div class="conv-item${active}" data-action="open-conv" data-course="${cid}" data-conv="${vid}">
          <div class="conv-item-content">
            <span class="conv-title${isDraft}">${escapeHtml(conv.title || 'New chat')}</span>
            <span class="conv-date">${fmtConvDate(conv.updated || conv.created)}</span>
          </div>
          <div class="conv-actions">
            <button class="conv-action-btn" title="Rename" data-action="rename-conv" data-course="${cid}" data-conv="${vid}">
              <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke-linecap="round" stroke-linejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button class="conv-action-btn" title="Delete" style="color:oklch(0.6 0.15 15 / 0.7)" data-action="delete-conv" data-course="${cid}" data-conv="${vid}">
              <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11v6M14 11v6" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  sidebarEl.innerHTML = html;
}

// ── Header ────────────────────────────────────────────────────────────────────

function _updateHeader(container, courseId) {
  const nameEl = container.querySelector('#tutor-header-name');
  const dateEl = container.querySelector('#tutor-header-date');
  const dotEl  = container.querySelector('#tutor-header-dot');
  const header = container.querySelector('.tutor-header');
  const course = (state.courses || {})[courseId];
  if (course) {
    if (nameEl) nameEl.textContent = course.name;
    if (dateEl) dateEl.textContent = course.exam_date || '';
    const color = COURSE_COLOR[courseId] || 'var(--t3)';
    if (dotEl)  dotEl.style.background = color;
    if (header) header.style.setProperty('--tutor-course-color', color);
  } else {
    if (nameEl) nameEl.textContent = 'AI Tutor';
    if (dateEl) dateEl.textContent = 'All courses';
    if (dotEl)  dotEl.style.background = 'var(--t3)';
    if (header) header.style.removeProperty('--tutor-course-color');
  }
  _updateSources(container, courseId);
}

function _updateSources(container, courseId) {
  const body = container.querySelector('#sources-panel-body');
  if (!body) return;
  const course = (state.courses || {})[courseId];
  if (!course) {
    body.innerHTML = '<p class="sources-empty">Select a course to see what the tutor is reading from.</p>';
    return;
  }

  const defCount  = (course.definitions  || []).length;
  const conCount  = (course.concepts     || []).length;
  const distCount = (course.distinctions || []).length;
  const exCount   = (course.examples     || []).length;

  const sessionsHtml = course.sessions.map(s => {
    const isActive = _sessionContext === s.id;
    const slidesHtml = (s.slides || []).map(sl =>
      `<div class="sources-slide${isActive ? ' sources-slide-active' : ''}">
        <svg viewBox="0 0 12 12" fill="none"><path d="M2 1h5l3 3v7H2V1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
        ${escapeHtml(sl.title)}
      </div>`
    ).join('');
    return `<div class="sources-session${isActive ? ' sources-session-active' : ''}">
      <div class="sources-session-title">
        ${isActive ? '<span class="sources-reading-dot"></span>' : ''}Session ${escapeHtml(String(s.id))}: ${escapeHtml(s.title)}
      </div>
      ${slidesHtml || '<div class="sources-slide sources-slide-none">No slides listed</div>'}
    </div>`;
  }).join('');

  const counts = [
    { label: 'Definitions',  n: defCount  },
    { label: 'Concepts',     n: conCount  },
    { label: 'Distinctions', n: distCount },
    { label: 'Examples',     n: exCount   },
  ].filter(r => r.n > 0);

  const countsHtml = counts.map(r =>
    `<div class="sources-count-row">
      <span>${escapeHtml(r.label)}</span>
      <span class="sources-count-val">${r.n}</span>
    </div>`
  ).join('');

  body.innerHTML = `
    <div class="sources-section">
      <div class="sources-section-label">Slide decks</div>
      ${sessionsHtml}
    </div>
    ${countsHtml ? `<div class="sources-section">
      <div class="sources-section-label">Also loaded</div>
      <div class="sources-counts">${countsHtml}</div>
    </div>` : ''}`;
}

// ── Notes mode ────────────────────────────────────────────────────────────────

function _updateNotesModeUI(container) {
  const btn     = container.querySelector('#notes-mode-btn');
  const copyBtn = container.querySelector('#notes-copy-btn');
  const header  = container.querySelector('.tutor-header');
  if (!btn) return;
  if (state.chat.notesMode) {
    btn.classList.add('active');
    btn.title = 'Exit notes mode';
    header?.classList.add('notes-mode-active');
    if (copyBtn) copyBtn.style.display = 'flex';
  } else {
    btn.classList.remove('active');
    btn.title = 'Write notes with the tutor';
    header?.classList.remove('notes-mode-active');
    if (copyBtn) copyBtn.style.display = 'none';
  }
}

// ── Model picker ──────────────────────────────────────────────────────────────

function _renderModelPicker(container) {
  const dropdown = container.querySelector('#model-picker-dropdown');
  const label    = container.querySelector('#model-picker-label');
  if (!dropdown || !label) return;
  const cur = MODELS.find(m => m.id === state.chat.model) || MODELS[1];
  label.textContent = cur.label;
  dropdown.innerHTML = MODELS.map(m => `
    <button class="model-option${m.id === state.chat.model ? ' active' : ''}" data-action="select-model" data-model="${m.id}">
      <div class="model-option-top">
        <span class="model-option-label">${m.label}</span>
        <span class="model-option-tag">${m.tagline}</span>
      </div>
      <div class="model-option-desc">${m.description}</div>
    </button>`).join('');
}

// ── Conversation management ───────────────────────────────────────────────────

function _newChat(container, courseId) {
  cleanupDraft();
  saveCurrentConv();
  updateMemory(state.chat.courseContext);
  _sessionContext = null;

  const id = 'c-' + Date.now();
  state.chat.currentConvId = id;
  state.chat.courseContext  = courseId;
  state.chat.history        = [];
  state.chat.notesMode      = false;
  _updateNotesModeUI(container);

  const data = loadChatData();
  if (!data.conversations[courseId]) data.conversations[courseId] = [];
  data.conversations[courseId].unshift({ id, title: 'New chat', created: Date.now(), updated: Date.now(), draft: true, messages: [] });
  saveChatData(data);

  _updateHeader(container, courseId);

  const msgArea = container.querySelector('#chat-messages');
  if (msgArea) {
    msgArea.innerHTML = '';
    const greetEl = document.createElement('div');
    greetEl.className = 'chat-msg chat-msg-ai';
    greetEl.innerHTML = buildGreetingHtml(courseId);
    msgArea.appendChild(greetEl);
    msgArea.scrollTop = 0;
  }

  _renderSidebar(container);
  container.querySelector('#chat-input')?.focus();
}

function _openConversation(container, courseId, convId) {
  cleanupDraft();
  saveCurrentConv();
  const data = loadChatData();
  const conv = (data.conversations[courseId] || []).find(c => c.id === convId);
  if (!conv) return;
  state.chat.courseContext  = courseId;
  state.chat.currentConvId = convId;
  state.chat.history        = conv.messages.slice();
  _updateHeader(container, courseId);
  const msgArea = container.querySelector('#chat-messages');
  if (msgArea) {
    msgArea.innerHTML = '';
    for (const msg of conv.messages) {
      if (msg.role === 'user') {
        msgArea.appendChild(_renderUserMsgEl(msg.content));
      } else {
        const el = document.createElement('div');
        el.className = 'chat-msg chat-msg-ai';
        el.innerHTML = renderMarkdown(msg.content || '');
        msgArea.appendChild(el);
      }
    }
    msgArea.scrollTop = msgArea.scrollHeight;
  }
  _renderSidebar(container);
}

function _selectCourse(container, courseId) {
  if (state.chat.courseContext === courseId && state.chat.currentConvId) {
    _renderSidebar(container);
    return;
  }
  cleanupDraft();
  saveCurrentConv();
  updateMemory(state.chat.courseContext);
  _sessionContext = null;
  state.chat.courseContext = courseId;
  state.chat.notesMode     = false;
  _updateNotesModeUI(container);
  _updateHeader(container, courseId);
  const data  = loadChatData();
  const convs = (data.conversations[courseId] || []).slice().sort((a, b) => b.updated - a.updated);
  if (convs.length > 0) {
    _openConversation(container, courseId, convs[0].id);
  } else {
    _newChat(container, courseId);
  }
}

// ── Mount / unmount ───────────────────────────────────────────────────────────

export function mount(container, params = {}) {
  container.innerHTML = `
    <div class="tutor-layout">
      <div class="tutor-sidebar-backdrop" id="tutor-sidebar-backdrop"></div>
      <div class="tutor-sidebar" id="tutor-sidebar"></div>
      <div class="tutor-main">
        <div class="tutor-header">
          <button class="tutor-menu-btn" id="tutor-menu-btn" aria-label="Select course">
            <svg viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
          <span class="tutor-header-dot" id="tutor-header-dot"></span>
          <div class="tutor-header-meta">
            <span class="tutor-header-name" id="tutor-header-name">AI Tutor</span>
            <span class="tutor-header-date" id="tutor-header-date">Select a course</span>
          </div>
        </div>
        <div id="chat-messages"></div>
        <div class="tutor-input-wrap">
          <input type="file" id="file-input" multiple accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/markdown,.md,.txt" style="display:none">
          <div class="chat-input-row">
            <div id="file-attachment-preview" class="file-attachment-preview" style="display:none"></div>
            <div class="chat-input-shell">
              <button class="chat-attach-btn" id="chat-attach-btn" title="Attach image or PDF" type="button">
                <svg viewBox="0 0 16 16" fill="none"><path d="M13.5 8.5L7.5 14.5a4 4 0 01-5.657-5.657l7-7a2.5 2.5 0 013.536 3.536L5.879 12.38A1 1 0 114.464 10.96l6.5-6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <textarea id="chat-input" class="chat-input" placeholder="Ask anything…" rows="1"></textarea>
              <button class="chat-voice-btn" id="chat-voice-btn" title="Start a voice conversation" type="button">
                <svg viewBox="0 0 16 16" fill="none"><rect x="6" y="2" width="4" height="8" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 7v1a4.5 4.5 0 009 0V7M8 12.5V14M5.5 14h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              </button>
              <button id="chat-send-btn" class="chat-send-btn" aria-label="Send">
                <svg viewBox="0 0 16 16"><path d="M8 13V3M3 8l5-5 5 5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
          </div>
          <div class="input-toolbar">
            <div class="input-toolbar-left">
              <button class="input-toolbar-btn" id="notes-mode-btn" title="Write notes with the tutor">
                <svg viewBox="0 0 16 16" fill="none"><path d="M2 13V3.5L5 2l3 1.5L11 2l3 1.5V13l-3-1-3 1-3-1-3 1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5 2v11M8 3.5V12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                <span>Notes</span>
              </button>
            </div>
            <div class="input-toolbar-right">
              <button class="input-toolbar-btn" id="notes-copy-btn" title="Copy notes" style="display:none;">
                <svg viewBox="0 0 16 16" fill="none"><rect x="5" y="2" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M2 5v9a1.5 1.5 0 001.5 1.5H11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                <span>Copy</span>
              </button>
              <div class="model-picker-wrap" id="model-picker-wrap">
                <button class="input-toolbar-btn model-picker-btn" id="model-picker-btn">
                  <svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                  <span id="model-picker-label">Sonnet</span>
                  <svg class="model-chevron" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <div class="model-picker-dropdown" id="model-picker-dropdown"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  // Initial state
  _renderSidebar(container);
  _renderModelPicker(container);
  _updateNotesModeUI(container);

  // Restore existing conversation or show welcome
  const msgArea = container.querySelector('#chat-messages');
  if (state.chat.currentConvId && state.chat.history.length > 0) {
    _updateHeader(container, state.chat.courseContext);
    for (const msg of state.chat.history) {
      if (msg.role === 'user') {
        msgArea.appendChild(_renderUserMsgEl(msg.content));
      } else {
        const el = document.createElement('div');
        el.className = 'chat-msg chat-msg-ai';
        el.innerHTML = renderMarkdown(msg.content || '');
        msgArea.appendChild(el);
      }
    }
    msgArea.scrollTop = msgArea.scrollHeight;
  } else {
    msgArea.innerHTML = `<div class="chat-msg chat-msg-ai">Hey ${escapeHtml(userName())}. Pick a course on the left to get started.</div>`;
  }

  // If called with a courseId param (e.g. from askTutorAbout), auto-select it
  if (params.courseId) {
    _newChat(container, params.courseId);
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  const fileInput = container.querySelector('#file-input');

  fileInput.addEventListener('change', e => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    const MAX_IMG = 5 * 1024 * 1024, MAX_PDF = 24 * 1024 * 1024, MAX_TEXT = 2 * 1024 * 1024, MAX_FILES = 5;
    const available = MAX_FILES - state.chat.pendingAttachments.length;
    for (const file of files.slice(0, available)) {
      const isPDF = file.type === 'application/pdf';
      const isText = file.type === 'text/plain' || file.type === 'text/markdown' || file.name.endsWith('.md') || file.name.endsWith('.txt');
      const limit = isPDF ? MAX_PDF : isText ? MAX_TEXT : MAX_IMG;
      if (file.size > limit) {
        alert(`${file.name} exceeds the ${isPDF ? '24 MB' : isText ? '2 MB' : '5 MB'} limit.`);
        continue;
      }
      const reader = new FileReader();
      if (isText) {
        reader.onload = ev => {
          state.chat.pendingAttachments.push({ name: file.name, mediaType: 'text/plain', text: ev.target.result });
          _renderAttachmentPreview(container);
        };
        reader.readAsText(file);
      } else {
        reader.onload = ev => {
          const [header, data] = ev.target.result.split(',');
          const mediaType = header.match(/:(.*?);/)[1];
          state.chat.pendingAttachments.push({ name: file.name, mediaType, data, previewUrl: mediaType.startsWith('image/') ? ev.target.result : null });
          _renderAttachmentPreview(container);
        };
        reader.readAsDataURL(file);
      }
    }
  });

  const layout   = container.querySelector('.tutor-layout');
  const backdrop = container.querySelector('#tutor-sidebar-backdrop');

  function closeSidebar() {
    layout.classList.remove('sidebar-open');
  }

  container.querySelector('#tutor-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    layout.classList.toggle('sidebar-open');
  });

  backdrop.addEventListener('click', closeSidebar);

  container.querySelector('#chat-attach-btn').addEventListener('click', () => fileInput.click());
  container.querySelector('#chat-voice-btn').addEventListener('click', () => window.openVoiceModal?.());
  container.querySelector('#chat-send-btn').addEventListener('click', () => _sendChat(container));
  const chatInput = container.querySelector('#chat-input');
  chatInput.addEventListener('input', () => {
    chatInput.style.height = '';
    chatInput.style.height = chatInput.scrollHeight + 'px';
  });
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendChat(container); }
  });

  container.querySelector('#notes-mode-btn').addEventListener('click', () => {
    if (!state.chat.courseContext) return;
    state.chat.notesMode = !state.chat.notesMode;
    _updateNotesModeUI(container);
    if (state.chat.notesMode) {
      cleanupDraft();
      saveCurrentConv();
      state.chat.currentConvId = 'c-' + Date.now();
      state.chat.history = [];
      msgArea.innerHTML = '';
      const greetEl = document.createElement('div');
      greetEl.className = 'chat-msg chat-msg-ai';
      const course = (state.courses || {})[state.chat.courseContext];
      const courseName = course ? escapeHtml(course.name) : 'this course';
      const sessions = course ? course.sessions : [];
      let greetHtml = `<span class="md-p">Notes mode. Let's build your revision notes for <strong>${courseName}</strong> together.</span>`;
      if (sessions.length) {
        greetHtml += `<span class="md-p" style="margin-top:0.5rem;color:var(--t2);">Which session do you want to cover?</span>`;
        greetHtml += `<div class="greeting-prompts">`;
        sessions.slice(0, 5).forEach(s => {
          greetHtml += `<button class="greeting-pill" data-send="${escapeHtml(`Session ${s.id}: ${s.title}`)}">Session ${s.id}: ${escapeHtml(s.title)}</button>`;
        });
        if (sessions.length > 5) greetHtml += `<button class="greeting-pill" data-send="Show me all sessions">All sessions…</button>`;
        greetHtml += `</div>`;
      }
      greetEl.innerHTML = greetHtml;
      msgArea.appendChild(greetEl);
      _renderSidebar(container);
      container.querySelector('#chat-input')?.focus();
    }
  });

  container.querySelector('#notes-copy-btn').addEventListener('click', () => {
    const lines = state.chat.history.filter(m => m.role === 'assistant').map(m => m.content).join('\n\n---\n\n');
    if (!lines) return;
    navigator.clipboard.writeText(lines).then(() => {
      const btn = container.querySelector('#notes-copy-btn');
      if (!btn) return;
      const orig = btn.innerHTML;
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none"><path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      setTimeout(() => { btn.innerHTML = orig; }, 1800);
    });
  });

  // Model picker toggle
  container.querySelector('#model-picker-btn').addEventListener('click', () => {
    container.querySelector('#model-picker-wrap').classList.toggle('open');
    _renderModelPicker(container);
  });

  // Close model picker when clicking outside
  function onDocClick(e) {
    const wrap = container.querySelector('#model-picker-wrap');
    if (wrap && !wrap.contains(e.target)) wrap.classList.remove('open');
  }
  document.addEventListener('click', onDocClick);

  // Sidebar + chat area delegation
  function onContainerClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action  = el.dataset.action;
    const courseId = el.dataset.course;
    const convId  = el.dataset.conv;
    const send    = el.dataset.send;
    e.stopPropagation();

    if (action === 'select-course') { _selectCourse(container, courseId); closeSidebar(); }
    else if (action === 'new-chat')   _newChat(container, courseId);
    else if (action === 'open-conv')  _openConversation(container, courseId, convId);
    else if (action === 'rename-conv') {
      const data = loadChatData();
      const conv = (data.conversations[courseId] || []).find(c => c.id === convId);
      if (!conv) return;
      const name = prompt('Rename conversation:', conv.title || 'Conversation');
      if (!name?.trim()) return;
      conv.title = name.trim(); conv.draft = false;
      saveChatData(data); _renderSidebar(container);
    }
    else if (action === 'delete-conv') {
      const data = loadChatData();
      if (!data.conversations[courseId]) return;
      data.conversations[courseId] = data.conversations[courseId].filter(c => c.id !== convId);
      saveChatData(data);
      if (state.chat.currentConvId === convId) {
        state.chat.currentConvId = null;
        state.chat.history = [];
        const remaining = (data.conversations[courseId] || []).sort((a, b) => b.updated - a.updated);
        if (remaining.length > 0) {
          _openConversation(container, courseId, remaining[0].id);
        } else {
          msgArea.innerHTML = '<div class="chat-msg chat-msg-ai">No conversations yet. Click "+ New chat" to start.</div>';
          _renderSidebar(container);
        }
      } else {
        _renderSidebar(container);
      }
    }
    else if (action === 'select-model') {
      state.chat.model = el.dataset.model;
      container.querySelector('#model-picker-wrap')?.classList.remove('open');
      _renderModelPicker(container);
    }
    // Greeting pills use data-send
    else if (send) _sendChat(container, send);
  }
  container.addEventListener('click', onContainerClick);

  // Expose globals needed by other modules and greeting pills
  window.sendChat = (preset) => _sendChat(container, preset);
  window.askTutorAbout = (courseId) => { navigate('tutor'); _newChat(container, courseId); };

  return function unmount() {
    document.removeEventListener('click', onDocClick);
    container.removeEventListener('click', onContainerClick);
    window.sendChat      = undefined;
    window.askTutorAbout = undefined;
  };
}
