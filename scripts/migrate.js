// migrate.js — seeds existing local JSON data into Supabase
// Run once: node migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DATA_DIR = path.join(__dirname, '..', 'data');
const COURSE_IDS = ['gtm', 'geopolitics', 'digital_strategy', 'ibm', 'ism'];

async function migrate() {
  console.log('Starting migration...\n');

  // ── 1. Migrate users ────────────────────────────────────────────────────────
  const usersFile = path.join(DATA_DIR, 'users.json');
  let users = [];
  try { users = JSON.parse(fs.readFileSync(usersFile)); } catch { console.log('No users.json found, skipping users.'); }

  for (const u of users) {
    const { error } = await supabase.from('users').upsert(
      { username: u.username, pin_hash: u.pinHash },
      { onConflict: 'username', ignoreDuplicates: true }
    );
    if (error) {
      console.error(`  ✗ User ${u.username}:`, error.message);
    } else {
      console.log(`  ✓ User ${u.username} migrated`);
    }
  }

  // ── 2. Migrate progress per user ────────────────────────────────────────────
  const progressFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('progress-') && f.endsWith('.json'));

  for (const file of progressFiles) {
    const username = file.replace('progress-', '').replace('.json', '');
    let progress;
    try { progress = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file))); } catch { continue; }

    // Look up user id
    const { data: user } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
    if (!user) {
      console.log(`  ⚠ No DB user for ${username}, skipping progress`);
      continue;
    }

    const progressRows = [];
    const wrongRows = [];

    for (const [courseId, courseData] of Object.entries(progress)) {
      if (!COURSE_IDS.includes(courseId)) continue;
      for (const [sessionId, sessionData] of Object.entries(courseData)) {
        if (sessionId === 'wrongQuestions') {
          for (const qid of sessionData) {
            wrongRows.push({ user_id: user.id, question_id: qid, course_id: courseId });
          }
          continue;
        }
        if (typeof sessionData !== 'object') continue;
        progressRows.push({
          user_id: user.id,
          course_id: courseId,
          session_id: sessionId,
          quiz_score: sessionData.quizScore ?? 0,
          notes_done: sessionData.notesDone ?? false
        });
      }
    }

    if (progressRows.length > 0) {
      const { error } = await supabase.from('user_progress')
        .upsert(progressRows, { onConflict: 'user_id,course_id,session_id', ignoreDuplicates: true });
      if (error) console.error(`  ✗ Progress for ${username}:`, error.message);
      else console.log(`  ✓ Progress for ${username}: ${progressRows.length} session rows`);
    }

    if (wrongRows.length > 0) {
      const { error } = await supabase.from('wrong_questions')
        .upsert(wrongRows, { onConflict: 'user_id,question_id', ignoreDuplicates: true });
      if (error) console.error(`  ✗ Wrong questions for ${username}:`, error.message);
      else console.log(`  ✓ Wrong questions for ${username}: ${wrongRows.length} rows`);
    }
  }

  // ── 3. Summary ──────────────────────────────────────────────────────────────
  console.log('\nMigration complete.');
  console.log('Next: run schema.sql in Supabase SQL Editor if you haven\'t already,');
  console.log('then start the app with: npm run dev\n');
}

migrate().catch(e => { console.error(e); process.exit(1); });
