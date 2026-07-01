#!/usr/bin/env node
/**
 * Upserts questions from data/seed/courses/*.json into Supabase course_questions.
 * Only inserts questions whose IDs don't already exist — safe to re-run.
 *
 * Usage:
 *   node scripts/import-quiz-questions.js              # all courses
 *   node scripts/import-quiz-questions.js --course gtm # one course
 *   node scripts/import-quiz-questions.js --dry-run    # preview only
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const args       = process.argv.slice(2);
const _get       = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const ONLY_COURSE = _get('--course');
const DRY_RUN    = args.includes('--dry-run');

const SEED_DIR = path.join(__dirname, '..', 'data', 'seed', 'courses');

async function main() {
  const files = fs.readdirSync(SEED_DIR).filter(f => f.endsWith('.json'));
  const courseFiles = ONLY_COURSE
    ? files.filter(f => f === `${ONLY_COURSE}.json`)
    : files;

  if (!courseFiles.length) {
    console.error('No matching seed files found. Check --course flag.');
    process.exit(1);
  }

  // Fetch existing question IDs from Supabase to avoid duplicates
  const { data: existing, error: existErr } = await supabase
    .from('course_questions')
    .select('id');
  if (existErr) throw existErr;
  const existingIds = new Set((existing || []).map(r => r.id));

  let totalInserted = 0;

  for (const file of courseFiles) {
    const courseId = path.basename(file, '.json');
    const course   = JSON.parse(fs.readFileSync(path.join(SEED_DIR, file), 'utf8'));
    const questions = course.questions || [];

    const newQuestions = questions.filter(q => !existingIds.has(q.id));
    if (!newQuestions.length) {
      console.log(`  ✓ ${courseId} — all ${questions.length} questions already in Supabase`);
      continue;
    }

    console.log(`  → ${courseId}: ${questions.length} total, ${newQuestions.length} new to insert`);

    const rows = newQuestions.map((q, i) => ({
      id:              q.id,
      course_id:       courseId,
      session_ext_id:  q.session,
      type:            q.type,
      question:        q.question,
      options:         q.options  || null,
      correct_answer:  q.correct  || null,
      model_answer:    q.model_answer  || null,
      key_points:      q.key_points    || null,
      explanation:     q.explanation   || null,
      order_idx:       1000 + i,
    }));

    if (DRY_RUN) {
      rows.forEach(r => console.log(`     [dry-run] would insert ${r.id} (${r.type})`));
      continue;
    }

    const { error: insertErr } = await supabase
      .from('course_questions')
      .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });

    if (insertErr) {
      console.error(`     ✗ ${courseId} failed: ${insertErr.message}`);
      continue;
    }

    console.log(`     ✓ inserted ${rows.length} questions`);
    totalInserted += rows.length;
  }

  console.log(`\nDone. ${DRY_RUN ? '(dry run — nothing written)' : `Inserted ${totalInserted} new questions total.`}`);
}

main().catch(err => { console.error(err); process.exit(1); });
