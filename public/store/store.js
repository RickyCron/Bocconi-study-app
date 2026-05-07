// ── Central state + event emitter ────────────────────────────────────────────
// Views subscribe to topics; only the affected subtree re-renders.
// Never import state from here and mutate it directly — always use patch() or
// assign to the object and call emit() so listeners fire.

const _listeners = new Map(); // topic → Set<fn>

export const state = {
  user: null,          // username string
  courses: null,       // { [courseId]: CourseObject } — loaded once on login
  questions: null,     // { [courseId]: Question[] } — loaded once on login
  progress: {},        // { [courseId]: ProgressObject }

  orbit: {
    data:          null,   // full StudyOrbitResponse from /api/study-orbit
    loading:       false,
    generating:    false,
    generatingIdx: 0,
    wizardOpen:    false,
    wizardStep:    0,
    wizardValues:  null,
    weekOffset:    0,
    selectedTaskId: null,
    setupOpen:     false,
    error:         null,
  },

  orbitChat: {
    open:            false,
    messages:        [],
    loading:         false,
    loadingLabel:    '',
    initialized:     false,
    pendingProposal: null,
  },

  chat: {
    history:           [],
    courseContext:     null,
    currentConvId:     null,
    notesMode:         false,
    pendingAttachments: [],
    model:             'claude-sonnet-4-6',
  },

  tts: { audio: null, text: '' },
};

export function emit(topic, payload) {
  const fns = _listeners.get(topic);
  if (fns) fns.forEach(fn => fn(payload));
  // Also fire '*' listeners (for debug / global refresh)
  const all = _listeners.get('*');
  if (all) all.forEach(fn => fn({ topic, payload }));
}

export function on(topic, fn) {
  if (!_listeners.has(topic)) _listeners.set(topic, new Set());
  _listeners.get(topic).add(fn);
}

export function off(topic, fn) {
  _listeners.get(topic)?.delete(fn);
}

// Set a nested path like 'orbit.weekOffset' and emit the top-level topic 'orbit'.
export function patch(dotPath, value) {
  const parts = dotPath.split('.');
  let obj = state;
  for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
  obj[parts[parts.length - 1]] = value;
  emit(parts[0], state[parts[0]]);
}
