#!/usr/bin/env node
/**
 * Seeds the Bocconi Supabase project with course content from data/courses/*.json
 * and uploads University Slides/*.pdf to the `course-slides` Storage bucket.
 *
 * Idempotent:
 *  - courses + content tables are wiped & rebuilt (cheap; makes order deterministic)
 *  - PDFs are only re-uploaded if missing from Storage
 *
 * Ends with a deep-diff verification: reconstructs loadAllCourses() output and
 * compares it to the original JSON. Allowed diffs: slides[i].file relative path
 * vs Supabase public URL. Anything else aborts.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const COURSES_DIR = path.join(__dirname, '..', 'data', 'seed', 'courses');
const SLIDES_DIR  = path.join(__dirname, '..', '..', 'University Slides');
const BUCKET      = 'course-slides';
const COURSE_IDS  = ['gtm', 'geopolitics', 'digital_strategy', 'ibm', 'ism'];

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function slugify(s) {
  return s.toLowerCase()
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function die(msg) { console.error('\n[FATAL]', msg); process.exit(1); }
function log(msg) { console.log(msg); }

async function ensureBucket() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) die(`listBuckets: ${error.message}`);
  if (buckets.find(b => b.name === BUCKET)) {
    log(`  ✓ bucket '${BUCKET}' exists`);
    return;
  }
  const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 50 * 1024 * 1024,
    allowedMimeTypes: ['application/pdf']
  });
  if (createErr) die(`createBucket: ${createErr.message}`);
  log(`  ✓ created bucket '${BUCKET}' (public, 50MB limit)`);
}

async function uploadIfMissing(courseId, relFile) {
  const absPath = path.join(SLIDES_DIR, relFile);
  if (!fs.existsSync(absPath)) die(`missing slide file on disk: ${absPath}`);
  const buf = fs.readFileSync(absPath);
  const sizeKb = Math.round(buf.length / 1024);

  const basename = path.basename(relFile, '.pdf');
  const storagePath = `${courseId}/${slugify(basename)}.pdf`;

  const { data: existing } = await supabase.storage.from(BUCKET).list(courseId, {
    search: path.basename(storagePath)
  });
  const already = (existing || []).some(f => f.name === path.basename(storagePath));

  if (!already) {
    const { error } = await supabase.storage.from(BUCKET).upload(storagePath, buf, {
      contentType: 'application/pdf',
      upsert: true
    });
    if (error) die(`upload ${relFile}: ${error.message}`);
    log(`    ↑ ${relFile} → ${storagePath} (${sizeKb} KB)`);
  } else {
    log(`    · ${storagePath} already in Storage (skipped)`);
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return { storage_path: storagePath, public_url: pub.publicUrl, file_size_kb: sizeKb };
}

// ────────────────────────────────────────────────────────────────────────────
// Seed one course
// ────────────────────────────────────────────────────────────────────────────

async function seedCourse(courseId, courseIdx) {
  log(`\n[${courseId}]`);
  const json = JSON.parse(fs.readFileSync(path.join(COURSES_DIR, courseId + '.json'), 'utf8'));

  // 1. upsert course row
  const { error: courseErr } = await supabase.from('courses').upsert({
    id: json.id,
    name: json.name,
    exam_date: json.exam_date || null,
    exam_format: json.exam_format || null,
    order_idx: courseIdx
  });
  if (courseErr) die(`courses upsert: ${courseErr.message}`);

  // 2. Delete content rows. For slides we only wipe migrated rows so uploads survive.
  for (const t of ['course_sessions','course_definitions','course_concepts','course_distinctions','course_examples','course_keywords','course_questions']) {
    const { error } = await supabase.from(t).delete().eq('course_id', courseId);
    if (error) die(`${t} delete: ${error.message}`);
  }
  {
    const { error } = await supabase.from('course_slides').delete().eq('course_id', courseId).eq('source', 'migrated');
    if (error) die(`course_slides delete (migrated): ${error.message}`);
  }

  // 3. sessions
  const sessionRows = (json.sessions || []).map((s, i) => ({
    course_id: courseId, ext_id: s.id, title: s.title,
    topics: s.topics || [], order_idx: i
  }));
  if (sessionRows.length) {
    const { error } = await supabase.from('course_sessions').insert(sessionRows);
    if (error) die(`course_sessions: ${error.message}`);
  }

  // 4. slides — upload PDFs, upsert rows (keyed by (course_id, storage_path))
  const slideResults = [];
  for (const [sIdx, s] of (json.sessions || []).entries()) {
    for (const [slIdx, sl] of (s.slides || []).entries()) {
      const up = await uploadIfMissing(courseId, sl.file);
      slideResults.push({
        course_id: courseId,
        session_ext_id: s.id,
        title: sl.title,
        storage_path: up.storage_path,
        public_url: up.public_url,
        file_size_kb: up.file_size_kb,
        source: 'migrated',
        order_idx: sIdx * 100 + slIdx
      });
    }
  }
  if (slideResults.length) {
    const { error } = await supabase.from('course_slides').insert(slideResults);
    if (error) die(`course_slides insert: ${error.message}`);
  }

  // 5. definitions
  const defRows = (json.definitions || []).map((d, i) => ({
    course_id: courseId, term: d.term, definition: d.definition, order_idx: i
  }));
  if (defRows.length) {
    const { error } = await supabase.from('course_definitions').insert(defRows);
    if (error) die(`course_definitions: ${error.message}`);
  }

  // 6. concepts
  const conRows = (json.concepts || []).map((c, i) => ({
    course_id: courseId, name: c.name, explanation: c.explanation, order_idx: i
  }));
  if (conRows.length) {
    const { error } = await supabase.from('course_concepts').insert(conRows);
    if (error) die(`course_concepts: ${error.message}`);
  }

  // 7. distinctions
  const distRows = (json.distinctions || []).map((d, i) => ({
    course_id: courseId, a: d.a, b: d.b, difference: d.difference, order_idx: i
  }));
  if (distRows.length) {
    const { error } = await supabase.from('course_distinctions').insert(distRows);
    if (error) die(`course_distinctions: ${error.message}`);
  }

  // 8. examples (plain strings)
  const exRows = (json.examples || []).map((t, i) => ({
    course_id: courseId, text: t, order_idx: i
  }));
  if (exRows.length) {
    const { error } = await supabase.from('course_examples').insert(exRows);
    if (error) die(`course_examples: ${error.message}`);
  }

  // 9. keywords (plain strings)
  const kwRows = (json.keywords || []).map((k, i) => ({
    course_id: courseId, keyword: k, order_idx: i
  }));
  if (kwRows.length) {
    const { error } = await supabase.from('course_keywords').insert(kwRows);
    if (error) die(`course_keywords: ${error.message}`);
  }

  // 10. questions — preserves id + all fields
  const qRows = (json.questions || []).map((q, i) => ({
    id: q.id,
    course_id: courseId,
    session_ext_id: q.session || null,
    type: q.type,
    question: q.question,
    options: q.options || null,
    correct_answer: q.correct || null,
    model_answer: q.model_answer || null,
    key_points: q.key_points || null,
    explanation: q.explanation || null,
    order_idx: i
  }));
  if (qRows.length) {
    const { error } = await supabase.from('course_questions').insert(qRows);
    if (error) die(`course_questions: ${error.message}`);
  }

  log(`  ✓ sessions=${sessionRows.length} slides=${slideResults.length} defs=${defRows.length} concepts=${conRows.length} distinctions=${distRows.length} examples=${exRows.length} keywords=${kwRows.length} questions=${qRows.length}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Reconstruct courses from DB (mirror of server.js loadCourse)
// ────────────────────────────────────────────────────────────────────────────

async function loadCourseFromDb(id) {
  const [c, sess, slides, defs, cons, dists, exs, kws, qs] = await Promise.all([
    supabase.from('courses').select('*').eq('id', id).maybeSingle(),
    supabase.from('course_sessions').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_slides').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_definitions').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_concepts').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_distinctions').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_examples').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_keywords').select('*').eq('course_id', id).order('order_idx'),
    supabase.from('course_questions').select('*').eq('course_id', id).order('order_idx'),
  ]);
  if (!c.data) die(`course ${id} not found in DB after seed`);

  const slidesBySession = {};
  for (const sl of (slides.data || [])) {
    const key = sl.session_ext_id || '__orphan__';
    (slidesBySession[key] = slidesBySession[key] || []).push({ title: sl.title, file: sl.public_url });
  }

  return {
    id: c.data.id,
    name: c.data.name,
    exam_date: c.data.exam_date,
    exam_format: c.data.exam_format,
    sessions: (sess.data || []).map(s => ({
      id: s.ext_id,
      title: s.title,
      topics: s.topics || [],
      slides: slidesBySession[s.ext_id] || []
    })),
    definitions: (defs.data || []).map(d => ({ term: d.term, definition: d.definition })),
    concepts:    (cons.data || []).map(c => ({ name: c.name, explanation: c.explanation })),
    distinctions:(dists.data|| []).map(d => ({ a: d.a, b: d.b, difference: d.difference })),
    examples:    (exs.data  || []).map(e => e.text),
    keywords:    (kws.data  || []).map(k => k.keyword),
    questions:   (qs.data   || []).map(q => {
      const out = { id: q.id, session: q.session_ext_id, type: q.type, question: q.question };
      if (q.type === 'open') {
        out.model_answer = q.model_answer;
        out.key_points = q.key_points || [];
      } else {
        out.options = q.options;
        out.correct = q.correct_answer;
      }
      if (q.explanation !== null && q.explanation !== undefined) out.explanation = q.explanation;
      return out;
    })
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Deep diff: original JSON vs DB-reconstructed, allowing slides[i].file swap
// ────────────────────────────────────────────────────────────────────────────

function diff(a, b, pathStr, diffs, ctx) {
  // special case: slides[i].file — allow relative → public URL swap
  if (pathStr.match(/^[a-z_]+\.sessions\[\d+\]\.slides\[\d+\]\.file$/)) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      diffs.push(`${pathStr}: type mismatch (${typeof a} vs ${typeof b})`);
      return;
    }
    // 'b' (DB value) should be a full URL pointing at Supabase Storage
    if (!b.startsWith('https://') || !b.includes('/storage/v1/object/public/course-slides/')) {
      diffs.push(`${pathStr}: DB value is not a Supabase public URL (${b})`);
    }
    return;
  }

  if (a === b) return;
  if (a === null || b === null || typeof a !== typeof b) {
    diffs.push(`${pathStr}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      diffs.push(`${pathStr}: array length ${a?.length} vs ${b?.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], `${pathStr}[${i}]`, diffs, ctx);
    return;
  }
  if (typeof a === 'object') {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    // For questions, DB may add `explanation` key; allow only identical key sets
    const missing = keysA.filter(k => !keysB.includes(k));
    const extra   = keysB.filter(k => !keysA.includes(k));
    if (missing.length || extra.length) {
      diffs.push(`${pathStr}: keys differ — missing in DB: [${missing.join(',')}] extra in DB: [${extra.join(',')}]`);
      return;
    }
    for (const k of keysA) diff(a[k], b[k], `${pathStr}.${k}`, diffs, ctx);
    return;
  }
  if (a !== b) diffs.push(`${pathStr}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

async function verify() {
  log(`\n[verify] deep-diff original JSON vs DB-reconstructed output`);
  const diffs = [];
  for (const id of COURSE_IDS) {
    const original = JSON.parse(fs.readFileSync(path.join(COURSES_DIR, id + '.json'), 'utf8'));
    const fromDb   = await loadCourseFromDb(id);
    diff(original, fromDb, id, diffs, { id });
  }
  if (diffs.length) {
    console.error('\n[FAIL] deep-diff found unexpected differences:');
    for (const d of diffs) console.error('  - ' + d);
    process.exit(1);
  }
  log(`  ✓ all 5 courses match byte-for-byte (slides URLs swapped as expected)`);
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

(async () => {
  log('[seed-courses] starting');
  log(`  SUPABASE_URL = ${process.env.SUPABASE_URL}`);

  log(`\n[storage] ensuring bucket`);
  await ensureBucket();

  for (let i = 0; i < COURSE_IDS.length; i++) {
    await seedCourse(COURSE_IDS[i], i);
  }

  await verify();

  log('\n[done] seed complete. Safe to switch server.js to DB-backed loadCourse.');
})().catch(err => die(err.stack || err.message));
