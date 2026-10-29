#!/usr/bin/env node
/**
 * Writes a realistic, entirely synthetic set of Claude Code and Codex sessions
 * (about 20 sessions across 5 projects) for developing and demoing the UI.
 *
 *   node scripts/demo-data.mjs [outDir]      (default .demo-data)
 *
 * Timestamps are relative to now, so "updated 5h ago" always looks fresh.
 * Nothing here comes from a real transcript.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? '.demo-data');
rmSync(out, { recursive: true, force: true });

const NOW = Date.now();
const H = 3_600_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
let counter = 0;
const uuid = (seed) => {
  counter++;
  const hex = (n, len) => ((n * 2654435761) >>> 0).toString(16).padStart(8, '0').repeat(4).slice(0, len);
  const s = seed * 7919 + counter;
  return `${hex(s, 8)}-${hex(s + 1, 4)}-4${hex(s + 2, 3)}-a${hex(s + 3, 3)}-${hex(s + 4, 12)}`;
};

const write = (rel, lines) => {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};

const HOME = '/Users/sam/code';
const encode = (cwd) => cwd.replace(/[/.]/g, '-');

/**
 * A believable context curve: context grows turn by turn, drops sharply at each
 * compaction, and ends at `final` tokens. Returns the points and the indexes
 * where compactions happen (before that point).
 */
function curve(final, compactions, window, seed) {
  const n = Math.max(6, compactions * 4 + 5 + Math.round(seedRand(seed) * 6));
  const segs = compactions + 1;
  const points = [];
  const marks = [];
  let base = Math.max(5_000, Math.round(final * 0.07));
  for (let sgi = 0; sgi < segs; sgi++) {
    const last = sgi === segs - 1;
    const len = last ? n - points.length : Math.floor(n / segs);
    const peak = last ? final : Math.round(window * (0.86 + seedRand(seed + sgi) * 0.08));
    for (let j = 1; j <= len; j++) {
      const t = j / len;
      const wiggle = last && j === len ? 0 : (seedRand(seed * 7 + points.length) - 0.5) * 0.04 * peak;
      points.push(Math.max(1_000, Math.round(base + (peak - base) * Math.pow(t, 0.9) + wiggle)));
    }
    if (!last) {
      marks.push(points.length);
      base = Math.round(peak * (0.18 + seedRand(seed + 40 + sgi) * 0.1));
    }
  }
  return { points, marks };
}

function seedRand(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const BUSYWORK = [
  { name: 'Read', input: (cwd, f) => ({ file_path: `${cwd}/${f}` }) },
  { name: 'Grep', input: () => ({ pattern: 'TODO|FIXME' }) },
  { name: 'Bash', input: () => ({ command: 'npm test -- --silent' }) },
  { name: 'Read', input: (cwd, f) => ({ file_path: `${cwd}/${f}` }) },
  { name: 'Bash', input: () => ({ command: 'git diff --stat' }) },
];

/**
 * Claude Code session.
 * ctx: final context size in tokens. files: files edited (relative to cwd).
 */
function claude({ cwd, branch, hoursAgo, minutes = 25, prompt, reply, finalText, followUp, files = [], ctx, compactions = 0, model = 'claude-opus-4-5', subagent }) {
  const id = uuid(hoursAgo * 13);
  const start = hoursAgo * H;
  const { points, marks } = curve(ctx, compactions, 200_000, hoursAgo);
  const step = (minutes * 60_000) / (points.length * 2 + 4);
  const base = { sessionId: id, cwd, gitBranch: branch, version: '2.4.1', userType: 'external' };
  let t = start;
  const at = () => iso((t -= step));
  const lines = [];
  let n = 0;
  const usage = (total) => ({
    input_tokens: 400,
    cache_creation_input_tokens: Math.round(total * 0.15),
    cache_read_input_tokens: Math.max(0, total - Math.round(total * 0.15) - 400 - 700),
    output_tokens: 700,
  });
  const say = (content, total) =>
    lines.push({ ...base, type: 'assistant', uuid: `a${n++}`, timestamp: at(), message: { id: `m${n}`, role: 'assistant', model, content, usage: usage(total) } });
  const results = (tools) =>
    lines.push({ ...base, type: 'user', uuid: `u${n++}`, timestamp: at(), message: { role: 'user', content: tools.map((tl) => ({ type: 'tool_result', tool_use_id: tl.id, content: 'ok' })) } });

  lines.push({ ...base, type: 'user', uuid: `u${n++}`, timestamp: at(), message: { role: 'user', content: prompt } });
  points.forEach((total, i) => {
    if (marks.includes(i)) {
      lines.push({ ...base, type: 'system', subtype: 'compact_boundary', uuid: `c${n++}`, timestamp: at(), content: 'Conversation compacted' });
    }
    const lastTurn = i === points.length - 1;
    if (i === 0) {
      say([{ type: 'text', text: reply }], total);
    } else if (lastTurn) {
      say([{ type: 'tool_use', id: `tz${i}`, name: 'Bash', input: { command: 'npm test' } }, { type: 'text', text: finalText }], total);
    } else if (i === 1 && files.length) {
      const tools = files.map((f, k) => ({ type: 'tool_use', id: `t${i}-${k}`, name: k === 0 ? 'Edit' : 'Write', input: { file_path: `${cwd}/${f}` } }));
      say(tools, total);
      results(tools);
    } else {
      const b = BUSYWORK[i % BUSYWORK.length];
      const tool = { type: 'tool_use', id: `t${i}`, name: b.name, input: b.input(cwd, files[0] ?? 'README.md') };
      say([tool], total);
      results([tool]);
    }
    if (followUp && i === Math.floor(points.length / 2)) {
      lines.push({ ...base, type: 'user', uuid: `u${n++}`, timestamp: at(), message: { role: 'user', content: followUp } });
    }
  });

  write(`claude/projects/${encode(cwd)}/${id}.jsonl`, lines);

  if (subagent) {
    const sb = { ...base, isSidechain: true };
    write(`claude/projects/${encode(cwd)}/${id}/subagents/agent-${id.slice(0, 8)}.jsonl`, [
      { ...sb, type: 'user', uuid: 's1', timestamp: iso(start - step), message: { role: 'user', content: subagent.prompt } },
      { ...sb, type: 'assistant', uuid: 's2', timestamp: iso(start - 2 * step), message: { id: 'ms', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: subagent.reply }], usage: { input_tokens: 6000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 300 } } },
    ]);
  }
}

/** Codex session. ctx: final context size; window 272k. */
function codex({ cwd, branch, hoursAgo, minutes = 20, prompt, reply, finalText, followUp, files = [], ctx, compactions = 0, model = 'gpt-5.5' }) {
  const id = uuid(hoursAgo * 17);
  const start = hoursAgo * H;
  const { points, marks } = curve(ctx, compactions, 272_000, hoursAgo + 0.5);
  const step = (minutes * 60_000) / (points.length * 3 + 6);
  let t = start;
  const at = () => iso((t -= step));
  const ev = (type, payload) => ({ timestamp: at(), type, payload });
  const startIso = iso(start);
  const lines = [
    { timestamp: startIso, type: 'session_meta', payload: { id, timestamp: startIso, cwd, originator: 'codex_cli_rs', cli_version: '0.134.0', git: { branch } } },
    ev('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>` }] }),
    ev('turn_context', { cwd, model, approval_policy: 'on-request' }),
    ev('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }),
  ];
  let totalIn = 0;
  let totalOut = 0;
  const tokens = (ctxNow) => {
    totalIn += ctxNow - 1500;
    totalOut += 1500;
    lines.push(ev('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: totalIn, output_tokens: totalOut }, last_token_usage: { input_tokens: ctxNow - 1500, output_tokens: 1500 }, model_context_window: 272000 } }));
  };
  points.forEach((ctxNow, i) => {
    if (marks.includes(i)) lines.push(ev('compacted', { message: 'Summary of the conversation so far…' }));
    const lastTurn = i === points.length - 1;
    if (i === 0) {
      lines.push(ev('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }));
    } else if (i === 1 && files.length) {
      const patch = ['*** Begin Patch', ...files.map((f, k) => `*** ${k === 0 ? 'Update' : 'Add'} File: ${f}`), '*** End Patch'].join('\n');
      lines.push(ev('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: `c${i}`, input: patch }));
      lines.push(ev('response_item', { type: 'custom_tool_call_output', call_id: `c${i}`, output: 'Success.' }));
    } else if (!lastTurn) {
      const cmd = ['rg -n "TODO" .', 'npm test', 'git status --short', 'ls -la'][i % 4];
      lines.push(ev('response_item', { type: 'function_call', name: 'shell', call_id: `c${i}`, arguments: JSON.stringify({ command: ['bash', '-lc', cmd] }) }));
      lines.push(ev('response_item', { type: 'function_call_output', call_id: `c${i}`, output: JSON.stringify({ output: '(output)', metadata: { exit_code: 0 } }) }));
    }
    if (followUp && i === Math.floor(points.length / 2)) {
      lines.push(ev('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: followUp }] }));
    }
    tokens(ctxNow);
    if (lastTurn) lines.push(ev('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: finalText }] }));
  });

  const d = new Date(NOW - start);
  const pad = (x) => String(x).padStart(2, '0');
  const day = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  const stamp = d.toISOString().slice(0, 19).replace(/:/g, '-');
  write(`codex/sessions/${day}/rollout-${stamp}-${id}.jsonl`, lines);
}

// ── acme-shop ────────────────────────────────────────────────────────────
const shop = `${HOME}/acme-shop`;
claude({ cwd: shop, branch: 'feature/session-cookies', hoursAgo: 52, minutes: 70, ctx: 142_000, compactions: 1,
  prompt: 'Our auth keeps the JWT in localStorage. Move it to httpOnly session cookies and keep the refresh flow working.',
  reply: "I'll read the session module and the API client first, then swap token storage for a cookie-backed session.",
  followUp: 'Keep the old header path working for the mobile app for one release.',
  finalText: 'Sessions now use an httpOnly, SameSite=Lax cookie. The Authorization header still works behind a flag for the mobile app. Two refresh tests fail; the refresh endpoint still reads the header.',
  files: ['src/auth/session.ts', 'src/auth/cookies.ts', 'src/api/client.ts'],
  subagent: { prompt: 'Find every caller of getToken() and list file:line.', reply: 'getToken() is called in src/api/client.ts:14, src/pages/account.tsx:52 and src/hooks/useUser.ts:9.' } });
codex({ cwd: shop, branch: 'feature/session-cookies', hoursAgo: 27, ctx: 58_000,
  prompt: 'The session refresh tests fail after the cookie refactor. Fix the refresh path so it reads the session cookie.',
  reply: 'Running the failing tests to see the exact assertion first.',
  finalText: 'refresh() now reads the session cookie via readSessionCookie(req). Added a regression test; all 48 auth tests pass.',
  files: ['src/auth/session.ts', 'src/auth/refresh.test.ts'] });
claude({ cwd: shop, branch: 'feature/session-cookies', hoursAgo: 5, ctx: 61_000,
  prompt: 'Add CSRF protection for the session cookie. Double-submit is fine.',
  reply: "I'll add a CSRF token cookie and check it against a header on every state-changing request.",
  finalText: 'Added src/auth/csrf.ts with a double-submit check on POST, PUT, PATCH and DELETE. The client sends X-CSRF-Token automatically.',
  files: ['src/auth/csrf.ts', 'src/auth/cookies.ts', 'src/api/client.ts'] });
codex({ cwd: shop, branch: 'fix/checkout-rounding', hoursAgo: 75, ctx: 91_000,
  prompt: 'Cart totals are off by one cent when a percentage discount and a coupon are both applied. Find out why.',
  reply: "Let me reproduce it with the order from the bug report, then trace where rounding happens.",
  finalText: 'The discount was rounded per line and again on the subtotal. Totals now use integer cents end to end and round once, at the end.',
  files: ['src/cart/totals.ts', 'src/cart/money.ts'] });
claude({ cwd: shop, branch: 'fix/checkout-rounding', hoursAgo: 49, ctx: 38_000, model: 'claude-sonnet-4-5',
  prompt: 'Write property-based tests for cart totals so this rounding bug cannot come back.',
  reply: "I'll use fast-check to generate carts with random discounts, coupons and quantities.",
  finalText: 'Added 6 properties, including "sum of line totals equals cart total" and "total never goes negative". They found one more edge case with 100% coupons, now fixed.',
  files: ['src/cart/totals.test.ts', 'src/cart/totals.ts'] });
claude({ cwd: shop, branch: 'main', hoursAgo: 140, ctx: 22_000, model: 'claude-sonnet-4-5',
  prompt: 'Explain how the nightly inventory sync job works, end to end.',
  reply: 'The job lives in jobs/inventory-sync.ts. Here is the flow from the supplier feed to the products table.',
  finalText: 'In short: fetch the supplier CSV, diff against yesterday, upsert changed SKUs in batches of 500, then purge the product cache.' });

// ── field-notes (mobile app) ─────────────────────────────────────────────
const notes = `${HOME}/field-notes`;
claude({ cwd: notes, branch: 'feature/offline-sync', hoursAgo: 98, minutes: 140, ctx: 176_000, compactions: 3,
  prompt: 'Design an offline-first sync queue for notes. Edits made on a plane should sync when the phone comes back online.',
  reply: "Before writing code, let me lay out the queue's states and what happens on each failure.",
  followUp: 'Use SQLite on the device, not AsyncStorage.',
  finalText: 'The queue persists operations in SQLite with states pending → sending → done/failed, and drains on reconnect. Upload retries are stubbed; that is the next step.',
  files: ['app/sync/queue.ts', 'app/sync/db.ts', 'app/sync/types.ts'] });
codex({ cwd: notes, branch: 'feature/offline-sync', hoursAgo: 71, ctx: 120_000, compactions: 1,
  prompt: 'Retry failed uploads in the sync queue with exponential backoff and jitter. Give up after 8 attempts.',
  reply: "I'll read app/sync/queue.ts first so the retries fit the existing state machine.",
  finalText: 'Added app/sync/retry.ts: backoff 1s → 2min with full jitter, max 8 attempts, then the op moves to "failed" and shows a badge.',
  files: ['app/sync/queue.ts', 'app/sync/retry.ts'] });
codex({ cwd: notes, branch: 'feature/offline-sync', hoursAgo: 20, ctx: 233_000, compactions: 2,
  prompt: 'What should happen when two devices edit the same note offline? Implement conflict resolution.',
  reply: "Options are last-write-wins, a three-way merge, or keeping both copies. Let me look at how notes are stored before choosing.",
  followUp: 'Go with three-way merge for the body and last-write-wins for the title.',
  finalText: 'Implemented a three-way merge for note bodies using the last synced version as the base; titles use last-write-wins. Conflicting hunks are kept and highlighted.',
  files: ['app/sync/merge.ts', 'app/sync/queue.ts', 'app/sync/merge.test.ts'] });
claude({ cwd: notes, branch: 'main', hoursAgo: 190, ctx: 47_000,
  prompt: 'The Android build fails after upgrading to Gradle 9. Here is the error output.',
  reply: 'This is the AGP / Gradle version mismatch. Let me check android/build.gradle.',
  finalText: 'Bumped the Android Gradle Plugin to 9.0 and replaced the removed packagingOptions block. The build passes.' });
codex({ cwd: notes, branch: 'main', hoursAgo: 46, ctx: 19_000, model: 'gpt-5.5-mini',
  prompt: 'Add a light haptic tap when the record button starts and stops recording.',
  reply: 'Adding expo-haptics calls to the press handlers.',
  finalText: 'RecordButton now plays a light impact on start and a medium one on stop.',
  files: ['app/components/RecordButton.tsx'] });

// ── infra ────────────────────────────────────────────────────────────────
const infra = `${HOME}/infra`;
claude({ cwd: infra, branch: 'feat/rds-upgrade', hoursAgo: 220, ctx: 84_000,
  prompt: 'Plan the Postgres 15 to 17 upgrade on RDS with as little downtime as possible.',
  reply: 'Blue/green deployments are the safest route here. Let me check which extensions you use first.',
  finalText: 'Plan: blue/green deployment, check pg_stat_statements and postgis compatibility, rehearse on staging, switch over in the Tuesday 06:00 window. Expected downtime under a minute.' });
codex({ cwd: infra, branch: 'feat/rds-upgrade', hoursAgo: 170, ctx: 66_000,
  prompt: 'Write the Terraform for the RDS blue/green deployment we planned.',
  reply: 'I will add an aws_rds_cluster blue_green_update block and a parameter group for 17.',
  finalText: 'Added the blue/green configuration and a pg17 parameter group to modules/rds. terraform plan shows 3 changes, no destroys.',
  files: ['modules/rds/main.tf', 'modules/rds/params.tf'] });
claude({ cwd: infra, branch: 'feat/rds-upgrade', hoursAgo: 150, ctx: 31_000, model: 'claude-sonnet-4-5',
  prompt: 'Review the RDS parameter group changes for anything risky.',
  reply: 'Reading modules/rds/params.tf against the Postgres 17 release notes.',
  finalText: 'Two concerns: max_connections drops from 400 to the default, and old_snapshot_threshold no longer exists. Both fixed.',
  files: ['modules/rds/params.tf'] });
codex({ cwd: infra, branch: 'main', hoursAgo: 290, ctx: 15_000,
  prompt: 'Rotate the staging TLS certificates before they expire on Friday.',
  reply: 'Checking which certificates are due with the ACM CLI.',
  finalText: 'Requested and validated new ACM certificates for *.staging and swapped them on both load balancers.' });

// ── blog ─────────────────────────────────────────────────────────────────
const blog = `${HOME}/blog`;
claude({ cwd: blog, branch: 'main', hoursAgo: 240, ctx: 12_000, model: 'claude-sonnet-4-5',
  prompt: 'Add an RSS feed for the blog posts, generated at build time.',
  reply: "I'll add a small build script that writes public/feed.xml.",
  finalText: 'Added scripts/build-feed.mjs and hooked it into npm run build.',
  files: ['scripts/build-feed.mjs'] });
claude({ cwd: blog, branch: 'main', hoursAgo: 360, ctx: 9_000, model: 'claude-sonnet-4-5',
  prompt: 'There is a flash of light mode before dark mode loads. Fix it.',
  reply: 'The theme is applied after hydration. An inline script in the head will fix that.',
  finalText: 'Added a tiny inline script that sets the theme class before first paint.',
  files: ['src/layouts/Base.astro'] });
codex({ cwd: blog, branch: 'main', hoursAgo: 23, ctx: 27_000,
  prompt: 'Outline a post: what I learned running two coding agents on the same project for a month.',
  reply: 'Here is a draft structure with five sections.',
  finalText: 'Outline saved to drafts/two-agents.md: setup, where each shines, handing work between them, losing track of context, what I would change.',
  files: ['drafts/two-agents.md'] });

// ── data-pipeline ────────────────────────────────────────────────────────
const data = `${HOME}/data-pipeline`;
codex({ cwd: data, branch: 'main', hoursAgo: 120, ctx: 104_000,
  prompt: 'Backfill the events that went missing between 3 and 9 March from the S3 archive.',
  reply: "I'll write a backfill job that reads the archived parquet files and replays them through the normal pipeline.",
  finalText: 'jobs/backfill.py replays 2.1M archived events through lib/events.py. Dry run matches the gap exactly.',
  files: ['jobs/backfill.py', 'lib/events.py'] });
claude({ cwd: data, branch: 'main', hoursAgo: 96, ctx: 69_000,
  prompt: 'The events dedupe step takes 40 minutes now. Make it faster.',
  reply: 'Profiling first. My guess is the pairwise comparison in lib/dedupe.py.',
  finalText: 'Replaced the pairwise comparison with a hash on (user_id, event_id, ts bucket). Dedupe now takes 3 minutes.',
  files: ['lib/dedupe.py', 'lib/events.py'] });
claude({ cwd: data, branch: 'main', hoursAgo: 40, ctx: 52_000,
  prompt: 'Since the dedupe change, late events (arriving more than 1h after they happened) are being dropped.',
  reply: 'That fits: the timestamp bucket can collide for late events. Let me write a failing test.',
  finalText: 'Late events now bucket on ingestion time as a tiebreaker. Added a test with events arriving 6h late.',
  files: ['lib/dedupe.py', 'tests/test_dedupe.py'] });
codex({ cwd: data, branch: 'main', hoursAgo: 0.2, minutes: 8, ctx: 14_000,
  prompt: 'Add a dashboard query that counts late events per day.',
  reply: 'Writing it against the events table, grouping by event date.',
  finalText: 'Added queries/late_events.sql.',
  files: ['queries/late_events.sql'] });

console.log(`Demo sessions written to ${out}`);
