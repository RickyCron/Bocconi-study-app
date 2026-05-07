// ── Course definitions — single source of truth ──────────────────────────────
// server.js keeps its own COURSE_EXAM_DATES constant — keep in sync with this.
export const COURSES = [
  { id: 'gtm',              name: 'GTM Strategies',  cssClass: 'c-gtm', examDate: '2026-05-18' },
  { id: 'geopolitics',      name: 'Geopolitics',      cssClass: 'c-geo', examDate: '2026-05-21' },
  { id: 'digital_strategy', name: 'Digital Strategy', cssClass: 'c-ds',  examDate: '2026-05-22' },
  { id: 'ibm',              name: 'IBM',              cssClass: 'c-ibm', examDate: '2026-05-27' },
  { id: 'ism',              name: 'ISM',              cssClass: 'c-ism', examDate: '2026-05-27' },
];

export const COURSE_MAP = Object.fromEntries(COURSES.map(c => [c.id, c]));

// Returns a Date object safe for timezone comparisons (noon local time)
export const EXAM_DATES = Object.fromEntries(
  COURSES.map(c => [c.id, new Date(c.examDate + 'T12:00:00')])
);

// ── Study Orbit ───────────────────────────────────────────────────────────────

export const ORBIT_STAGE_LABELS = {
  first_pass:       'First pass',
  knowledge_update: 'Knowledge update',
  deep_work:        'Deep work',
  retrieval:        'Retrieval',
  spaced_review:    'Spaced review',
  mixed_review:     'Mixed review',
};

export const ORBIT_TOOL_LABELS = {
  notes:     'Notes tool',
  agent:     'Agent tool',
  quiz:      'Quiz tool',
  canvas:    'Canvas tool',
  schematic: 'Schematic tool',
  mindmap:   'Mindmap tool',
};

export const ORBIT_RATING_FIELDS = [
  { id: 'slideLoad',          label: 'Slides' },
  { id: 'lectureDepth',       label: 'Lecture depth' },
  { id: 'requiredDepth',      label: 'Required depth' },
  { id: 'syllabusDifficulty', label: 'Difficulty' },
  { id: 'effort',             label: 'Effort' },
];

export const ORBIT_RATINGS = ['low', 'medium', 'high'];

export const WIZARD_TECHNIQUES = [
  { id: 'notes',     label: 'Write notes',   desc: 'Structured first-pass notes' },
  { id: 'update',    label: 'Update notes',  desc: 'Fill gaps in existing notes' },
  { id: 'deeper',    label: 'Deep dive',     desc: 'Reason through hard concepts' },
  { id: 'quiz',      label: 'Quiz yourself', desc: 'Active recall practice' },
  { id: 'video',     label: 'Watch video',   desc: 'Supplementary video content' },
  { id: 'canvas',    label: 'Canvas review', desc: 'Visual layout from memory' },
  { id: 'schematic', label: 'Schematic',     desc: 'Diagrams and flowcharts' },
  { id: 'mindmap',   label: 'Mind map',      desc: 'Concept relationship mapping' },
];

// Used in the preferences panel (orbit setup)
export const ORBIT_TECHNIQUES = [
  { id: 'notes',     label: 'Notes' },
  { id: 'update',    label: 'Update' },
  { id: 'deeper',    label: 'Deeper' },
  { id: 'quiz',      label: 'Quiz' },
  { id: 'video',     label: 'Video' },
  { id: 'canvas',    label: 'Canvas' },
  { id: 'schematic', label: 'Schematic' },
  { id: 'mindmap',   label: 'Mindmap' },
];

export const GENERATING_MSGS = [
  'Crunching lecture order…',
  'Weighing exam pressure…',
  'Scheduling deep work blocks…',
  'Carving out breathing room…',
  'Adding strategic quiz sessions…',
  'Factoring in your study hours…',
  'Aligning sessions with exam dates…',
  'Sprinkling in spaced reviews…',
  'Balancing course load…',
  'Almost there — nearly ready…',
];

// ── Claude models ─────────────────────────────────────────────────────────────
export const MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku',  tagline: 'Fast · Low cost',         description: 'Quick answers for flashcards and simple Q&A. Burns far fewer credits.' },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet', tagline: 'Balanced · Default',       description: 'Strong reasoning at moderate cost. Good for most study sessions.' },
  { id: 'claude-opus-4-6',           label: 'Opus',   tagline: 'Most capable · High cost', description: 'Best for hard concepts and tricky exam questions. Use sparingly.' },
];
