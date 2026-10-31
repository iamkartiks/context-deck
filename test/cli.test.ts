import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { addDecision, loadDecisions } from '../src/decisions.js';
import { Store } from '../src/store.js';
import { REPO, scratch } from './helpers.js';

const s = scratch();
const BIN = join(REPO, 'bin/contextdeck.js');

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [BIN, '--home', s.home, '--claude-dir', s.claude, '--codex-dir', s.codex, '--qwen-dir', s.qwen, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('cli', () => {
  after(() => s.cleanup());

  it('prints help and version', () => {
    assert.match(run('--help').out, /contextdeck/);
    assert.match(run('--version').out, /^\d+\.\d+\.\d+/);
  });

  it('indexes and reports a JSON summary', () => {
    const r = run('index', '--json');
    assert.equal(r.code, 0, r.err);
    const sum = JSON.parse(r.out);
    assert.equal(sum.indexed, 8);
    assert.equal(r.err, '', 'no experimental-warning noise on stderr');
  });

  it('list --json returns sessions', () => {
    const rows = JSON.parse(run('list', '--json').out);
    assert.equal(rows.length, 6);
    assert.ok(rows[0].shortId);
  });

  it('search finds text across tools', () => {
    const r = run('search', 'cookie');
    assert.equal(r.code, 0);
    assert.match(r.out, /Claude Code/);
    assert.match(r.out, /Codex CLI/);
  });

  it('show includes the resume command', () => {
    const r = run('show', 'cx:d5e6f701');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /codex resume 019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701/);
  });

  it('resume prints the command without running it', () => {
    const r = run('resume', 'cc:0f3a1b11');
    // In the shell of the system the tests run on
    assert.equal(
      r.out.trim(),
      process.platform === 'win32'
        ? 'Set-Location /Users/alice/code/acme-shop; claude --resume 7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11'
        : 'cd /Users/alice/code/acme-shop && claude --resume 7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11',
    );
  });

  it('related, projects, stats and doctor succeed', () => {
    assert.match(run('related', 'cc:0f3a1b11').out, /1 shared file/);
    assert.match(run('projects').out, /acme-shop/);
    assert.equal(JSON.parse(run('stats', '--json').out).sessions, 6);
    assert.equal(run('doctor').code, 0);
  });

  it('hands a session off: prints a brief, or saves it with a start command', () => {
    const printed = run('handoff', 'cc:0f3a1b11', '--print');
    assert.equal(printed.code, 0, printed.err);
    assert.match(printed.out, /^# Continue: Move auth/);
    assert.match(printed.out, /ContextDeck handoff hf_[0-9a-f]{10} from claude-code:/);

    const saved = JSON.parse(run('handoff', 'cc:0f3a1b11', '--json').out);
    assert.match(
      saved.command,
      process.platform === 'win32' ? /^codex 'Continue: .* Read the handoff brief in .*\.md and follow it\. \(ContextDeck handoff / : /^codex "\$\(cat '?.*\.md'?\)"$/,
      'defaults to the other tool',
    );
    assert.equal(JSON.parse(run('handoff', 'cx:d5e6f701', '--json').out).command.startsWith('claude '), true);
    assert.equal(JSON.parse(run('handoff', 'cc:0f3a1b11', '--to', 'cc', '--json').out).command.startsWith('claude '), true);
    assert.equal(JSON.parse(run('handoff', 'cc:0f3a1b11', '--to', 'qw', '--json').out).command.startsWith('qwen -i '), true);
    assert.equal(run('handoff', 'cc:0f3a1b11', '--to', 'gemini').code, 2);
    assert.equal(run('handoff').code, 2);
  });

  it('lists decisions, and shows them in search and show', () => {
    assert.match(run('decisions').out, /No decisions yet/);
    const store = new Store(join(s.home, 'index.db'));
    try {
      const id = store.resolve('cc:0f3a1b11').id;
      const seq = store.matchesIn(id, 'httpOnly')[0]!.seq;
      addDecision(s.home, store, { sessionId: id, seq, text: 'Use httpOnly session cookies' });
    } finally {
      store.close();
    }
    const list = run('decisions');
    assert.equal(list.code, 0, list.err);
    assert.match(list.out, /◆ Use httpOnly session cookies\n  cc:0f3a1b11  Claude Code  acme-shop/);
    assert.match(run('decisions', 'cookies').out, /Use httpOnly/);
    assert.match(run('decisions', 'postgres').out, /No decisions match/);
    const json = JSON.parse(run('decisions', '--json').out);
    assert.equal(json[0].text, 'Use httpOnly session cookies');
    assert.equal(json[0].session.shortId, 'cc:0f3a1b11');
    assert.match(run('search', 'httponly').out, /^Decisions\n◆ Use httpOnly session cookies/);
    assert.ok(Array.isArray(JSON.parse(run('search', 'httponly', '--json').out)), 'search --json stays a list of hits');
    assert.match(run('show', 'cc:0f3a1b11').out, /Decisions \(1\)\n  ◆ Use httpOnly session cookies/);

    // Files it covers changed later, in Codex and Qwen Code
    assert.match(list.out, /decided .+\n  ! src\/auth\/session\.ts changed since \(qw:3c4d5e61 .+, cx:d5e6f701 .+\)/);
    assert.match(list.out, /1 decision may be out of date/);
    assert.match(run('decisions', '--changed').out, /Use httpOnly session cookies/);
    assert.equal(json[0].changes[0].path, '/Users/alice/code/acme-shop/src/auth/session.ts');
    assert.match(json[0].decidedAt, /^2026-10-26T/);
  });

  it('hides replaced decisions unless asked', () => {
    const store = new Store(join(s.home, 'index.db'));
    try {
      const [old] = loadDecisions(s.home).decisions;
      addDecision(s.home, store, { sessionId: store.resolve('qw:3c4d5e61').id, seq: 0, text: 'Cookies, rotated hourly', replaces: old!.id });
    } finally {
      store.close();
    }
    const list = run('decisions').out;
    assert.match(list, /Cookies, rotated hourly/);
    assert.doesNotMatch(list, /Use httpOnly session cookies/);
    assert.match(run('decisions', '--all').out, /◇ Use httpOnly session cookies[\s\S]*replaced by a newer decision/);
    assert.doesNotMatch(run('search', 'httponly').out, /^Decisions/, 'search leaves replaced ones out');
  });

  it('uses exit code 2 for usage errors and 1 for failures', () => {
    assert.equal(run('nonsense').code, 2);
    assert.equal(run('search').code, 2);
    assert.equal(run('list', '--limit', 'abc').code, 2);
    assert.equal(run('--not-a-flag').code, 2);
    const missing = run('show', 'does-not-exist');
    assert.equal(missing.code, 1);
    assert.match(missing.err, /No session matches/);
  });
});
