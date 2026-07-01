#!/usr/bin/env node
/**
 * Pads every course session in Supabase up to TARGET questions.
 * Safe to re-run — only generates for sessions that are below the target.
 *
 * Usage:
 *   node scripts/seed-questions.js              # pad all sessions to 5
 *   node scripts/seed-questions.js --target 8   # pad to 8
 *   node scripts/seed-questions.js --course gtm # one course only
 *   node scripts/seed-questions.js --dry-run    # show what would be generated
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const args = process.argv.slice(2);
const _get  = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const TARGET      = parseInt(_get('--target') || '5', 10);
const ONLY_COURSE = _get('--course');
const DRY_RUN     = args.includes('--dry-run');
const API_KEY_ARG = _get('--api-key');

const ANTHROPIC_KEY = API_KEY_ARG || process.env.CLAUDE_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error('Pass your Anthropic key: node scripts/seed-questions.js --api-key sk-ant-...');
  process.exit(1);
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`);
  return data.content?.[0]?.text || '';
}

function buildPrompt(course, session, count) {
  const isGtmFinancial = course.id === 'gtm' && session.id === '14-23';
  const isIbm = course.id === 'ibm';
  const isIsm = course.id === 'ism';
  const isGeopolitics = course.id === 'geopolitics';

  if (isGtmFinancial) {
    return `You are a Bocconi University exam question generator for the Go-To-Market Strategies for Startups course.

Session: ${session.title}
Topics: ${session.topics.join('\n- ')}

Generate ${count} financial CALCULATION MCQ questions. These must follow the exact format of the real exam:
- Provide a business scenario with specific numbers (€ amounts, percentages, days, months)
- Ask the student to compute a specific financial figure
- Give 4 numerical options (a, b, c, d) — exactly one correct, the other three based on specific calculation mistakes
- The "explanation" field must show the correct formula/calculation AND explain each distractor's error

Question types to rotate through (pick appropriate ones given the session topics):
- TEV / pricing: TEV = reference price + positive differentials - negative differentials
- Revenue calculation: top-down (market × penetration × ARPU), bottom-up (capacity × occupancy × price), multi-source, subscription with churn
- Fixed vs variable cost classification: label each cost item V or F
- Interest expenses: ALWAYS use average balance = (opening + closing) / 2 × rate (never year-end balance alone)
- Income taxes with loss carry-forward: cumulate losses, offset against first profitable year
- Accounts receivable: revenues × (DSO / working days) × (1 + VAT rate) for domestic; NO VAT for export
- Inventory: cost base × (DIO / 12); finished goods include SSP = labour × 1/18
- Accounts payable: purchases × (DPO / 360) × (1 + VAT rate)
- Working capital: operating current assets (AR + inventory + VAT receivable + operating cash) MINUS operating current liabilities (AP + tax payable + SSP fund); bank overdraft is FINANCIAL, exclude it
- Invested capital: working capital + net fixed assets
- Financial needs: WC + NFA - EBIT (EBIT is subtracted — it self-finances)
- Net financial debt: bank overdraft + long-term loans - cash equivalents (operating cash excluded)
- Shareholders' equity: common stock + prior retained earnings + net income - dividends paid this year

Return ONLY a valid JSON array:
[
  {
    "session": "${session.id}",
    "type": "mcq_calc",
    "question": "...[scenario with specific numbers]...",
    "options": {"a": "€...", "b": "€...", "c": "€...", "d": "€..."},
    "correct": "b",
    "explanation": "Correct calculation: ... Distractor a) error because... Distractor c) error because... Distractor d) error because..."
  }
]`;
  }

  if (isIbm) {
    return `You are a Bocconi University exam question generator for the International Business & Management course (30215).

Session: ${session.title}
Topics: ${session.topics.join(', ')}
In-class cases and concepts to draw from: Danone (BU classification by product type), Wal-Mart in Germany (cultural distance failure), IKEA in China (economic distance — prices not affordable), Jollibee Foods (Philippines, multidomestic strategy), Philips-Matsushita (different BUs need different strategies), CATL in Germany (market-seeking + resource-seeking FDI for BMW), Porter's Diamond (factor conditions, demand conditions, related industries, firm rivalry, chance, government), path dependence (inability to adapt), Global Mindset (Empathy + Engagement + Ethics — NOT Environment), CAGE distances (Cultural, Administrative, Geographical, Economic), arbitrage (production delocalization to lowest-cost country), rapid entry matrix (high potential + high ability), liability of foreignness, world mandate subsidiary.

Generate ${count} exam-style MCQ questions. Use the format: "Select one correct statement:" or "Which of the following is correct?" — the student picks the ONE true statement (not the false one). Reference specific in-class cases where appropriate (Wal-Mart, IKEA, Jollibee, Philips, Porter's Diamond, etc.).

Make 3 options plausibly wrong and 1 clearly correct based on course content.

Return ONLY a valid JSON array:
[
  {
    "session": "${session.id}",
    "type": "mcq_correct",
    "question": "...",
    "options": {"a": "...", "b": "...", "c": "...", "d": "..."},
    "correct": "b",
    "explanation": "..."
  }
]`;
  }

  if (isIsm) {
    return `You are a Bocconi University exam question generator for the Information Systems Management course.

Session: ${session.title}
Topics: ${session.topics.join(', ')}

Generate ${count} open-ended exam questions. IMPORTANT: these must follow the real exam format:
- Provide a short business case/scenario (2–4 sentences describing a company, its situation, and an IS decision they have made)
- Ask the student to: (a) identify the IS type or concept, (b) describe the relevant framework/modules/process, and (c) justify a specific decision
- The question should be multi-part but framed as a single paragraph
- model_answer should be structured with clear sections matching each part of the question
- key_points should list the specific items the examiner looks for

Example question style: "A mid-sized manufacturing company has implemented a system that tracks all purchase orders, manages inventory levels, and automatically alerts procurement when stock falls below reorder thresholds, integrated with the finance department's payment processing. Given this description, what kind of IS has the company adopted? Describe the main modules typically found in this type of IS. Explain why integration across departments is a key characteristic of this IS."

Return ONLY a valid JSON array:
[
  {
    "session": "${session.id}",
    "type": "open",
    "question": "...[business scenario]... [multi-part question]",
    "model_answer": "...",
    "key_points": ["...", "...", "..."]
  }
]`;
  }

  // Default: Geopolitics and Digital Strategy
  const format = isGeopolitics
    ? `Use the Bocconi "NOT correct" style: "Which of the following statements is NOT correct?" with 4 options where exactly one is false.`
    : `Mix of "NOT correct" MCQ and open-ended questions.`;

  return `You are a Bocconi University exam question generator.

Course: ${course.name}
Exam format: ${course.exam_format}
Session: ${session.title}
Topics: ${session.topics.join(', ')}

Generate ${count} exam-style questions for this session.
${format}

Return ONLY a valid JSON array with this format:
[
  {
    "session": "${session.id}",
    "type": "mcq_not_correct",
    "question": "...",
    "options": {"a": "...", "b": "...", "c": "...", "d": "..."},
    "correct": "b",
    "explanation": "..."
  }
]

For open questions use type "open" with fields: question, model_answer, key_points (array).
Make questions genuinely challenging and exam-realistic.`;
}

async function generateQuestions(course, session, count) {
  const prompt = buildPrompt(course, session, count);

  const text = await callClaude(prompt);
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON array in Claude response');
  return JSON.parse(match[0]);
}

async function main() {
  // Load all courses
  const { data: courseRows, error: courseErr } = await supabase
    .from('courses')
    .select('id, name, exam_format');
  if (courseErr) throw courseErr;

  const courses = ONLY_COURSE
    ? courseRows.filter(c => c.id === ONLY_COURSE)
    : courseRows;

  if (!courses.length) { console.error('No courses found (check --course flag)'); process.exit(1); }

  // Load all sessions
  const { data: sessionRows, error: sessErr } = await supabase
    .from('course_sessions')
    .select('id, course_id, ext_id, title, topics');
  if (sessErr) throw sessErr;

  // Count existing questions per course+session
  const { data: qRows, error: qErr } = await supabase
    .from('course_questions')
    .select('course_id, session_ext_id');
  if (qErr) throw qErr;

  const qCount = {};
  for (const q of qRows || []) {
    const key = `${q.course_id}:${q.session_ext_id}`;
    qCount[key] = (qCount[key] || 0) + 1;
  }

  let totalAdded = 0;

  for (const course of courses) {
    const sessions = sessionRows.filter(s => s.course_id === course.id);
    for (const session of sessions) {
      const existing = qCount[`${course.id}:${session.ext_id}`] || 0;
      const needed   = Math.max(0, TARGET - existing);
      if (needed === 0) {
        console.log(`  ✓ ${course.id} / ${session.ext_id} — ${existing} questions (ok)`);
        continue;
      }

      console.log(`  → ${course.id} / ${session.ext_id} "${session.title}" — ${existing} existing, generating ${needed}...`);
      if (DRY_RUN) continue;

      try {
        const questions = await generateQuestions(
          { name: course.name, exam_format: course.exam_format },
          { id: session.ext_id, title: session.title, topics: session.topics || [] },
          needed
        );

        const ts = Date.now();
        const rows = questions.map((q, i) => ({
          id: `gen-${course.id}-${session.ext_id}-${ts}-${i}`,
          course_id: course.id,
          session_ext_id: session.ext_id,
          type: q.type,
          question: q.question,
          options: q.options || null,
          correct_answer: q.correct || null,
          model_answer: q.model_answer || null,
          key_points: q.key_points || null,
          explanation: q.explanation || null,
          order_idx: existing + i,
        }));

        const { error: insertErr } = await supabase.from('course_questions').insert(rows);
        if (insertErr) throw insertErr;

        console.log(`     ✓ added ${rows.length} questions (total: ${existing + rows.length})`);
        totalAdded += rows.length;

        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.error(`     ✗ failed: ${err.message}`);
      }
    }
  }

  console.log(`\nDone. ${DRY_RUN ? '(dry run)' : `Added ${totalAdded} questions total.`}`);
}

main().catch(err => { console.error(err); process.exit(1); });
