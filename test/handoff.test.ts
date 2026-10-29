import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { codexAdapter } from '../src/adapters/codex.js';
import { loadConfig } from '../src/config.js';
import { buildBrief, finalizeBrief, MAX_BRIEF_CHARS, saveBrief, startLine } from '../src/handoff.js';
import { ensureMarker, handoffMarker, newHandoffId, parseHandoffMarker } from '../src/handoff-marker.js';
import { indexSources } from '../src/indexer.js';
import { Store } from '../src/store.js';
import { scratch } from './helpers.js';

const SOURCE = 'claude-code:7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11';

/** Write a Codex rollout whose first prompt is `prompt`, as Codex would after `codex "<prompt>"`. */
function writeCodexSession(codexRoot: string, id: string, prompt: string, cwd = '/Users/alice/code/acme-shop'): void {
  const dir = join(codexRoot, 'sessions/2026/10/29');
  mkdirSync(dir, { recursive: true });
  const ev = (ts: string, type: string, payload: unknown) => JSON.stringify({ timestamp: ts, type, payload });
  writeFileSync(
    join(dir, `rollout-2026-10-29T06-00-00-${id}.jsonl`),
    [
      ev('2026-10-29T06:00:00Z', 'session_meta', { id, cwd, git: { branch: 'feature/session-cookies' } }),
      ev('2026-10-29T06:00:01Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }),
      ev('2026-10-29T06:00:09Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'git status shows two modified files. Next I would fix the refresh endpoint.' }] }),
    ].join('\n') + '\n',
  );
}

describe('handoff marker', () => {
  it('makes ids in the expected shape', () => {
    assert.match(newHandoffId(), /^hf_[0-9a-f]{10}$/);
    assert.notEqual(newHandoffId(), newHandoffId());
  });

  it('round-trips through text', () => {
    const text = `# Continue: x\n\n${handoffMarker('hf_0123456789', SOURCE)}\n\nbody`;
    assert.deepEqual(parseHandoffMarker(text), { id: 'hf_0123456789', from: SOURCE });
    assert.equal(parseHandoffMarker('no marker here'), null);
  });

  it('puts the marker back if someone deleted it, and fixes a wrong one', () => {
    const restored = ensureMarker('# Continue: x\nbody', 'hf_0123456789', SOURCE);
    assert.deepEqual(parseHandoffMarker(restored), { id: 'hf_0123456789', from: SOURCE });
    assert.ok(restored.startsWith('# Continue: x\n'), 'title stays on the first line');

    const wrong = ensureMarker(`# T\n${handoffMarker('hf_aaaaaaaaaa', SOURCE)}\nbody`, 'hf_0123456789', SOURCE);
    assert.deepEqual(parseHandoffMarker(wrong), { id: 'hf_0123456789', from: SOURCE });
    assert.equal(wrong.match(/ContextDeck handoff/g)?.length, 1);

    const ok = `# T\n${handoffMarker('hf_0123456789', SOURCE)}\nbody`;
    assert.equal(ensureMarker(ok, 'hf_0123456789', SOURCE), ok, 'a correct brief is left alone');
  });
});

describe('handoff', () => {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex }, {});
  let store: Store;

  before(async () => {
    store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
  });
  after(() => {
    store.close();
    s.cleanup();
  });

  it('writes a brief with everything a new agent needs', () => {
    const b = buildBrief(store, 'cc:0f3a1b11', { to: 'codex' });
    assert.equal(b.toLabel, 'Codex CLI');
    assert.equal(b.targetWindow, 272_000);
    const t = b.text;
    assert.ok(t.startsWith('# Continue: Move auth from localStorage tokens to httpOnly session cookies\n'));
    assert.deepEqual(parseHandoffMarker(t), { id: b.handoffId, from: SOURCE });
    assert.match(t, /started in Claude Code/);
    assert.match(t, /- Project folder: \/Users\/alice\/code\/acme-shop/);
    assert.match(t, /- Branch: feature\/session-cookies/);
    assert.match(t, /compacted once/);
    assert.match(t, /## The goal\n\nOur auth stores the JWT in localStorage/);
    assert.match(t, /## Later instructions\n\n1\. Also add CSRF protection/);
    assert.match(t, /Two session tests still fail on the refresh path/, 'includes where it got to');
    assert.match(t, /## Files it changed\n\n- src\/auth\/cookies\.ts\n- src\/auth\/session\.ts/, 'files are relative to the project');
    assert.match(t, /- Bash: npm test -- auth/);
    assert.doesNotMatch(t, /- Read:/, 'plain file reads are left out');
    assert.doesNotMatch(t, /\/compact/, 'slash commands are not instructions');
    assert.match(t, /wait for my go-ahead before changing any files/);
    assert.equal(b.tokens, Math.ceil(t.length / 4));
  });

  it('can let the new agent carry on without checking in', () => {
    const t = buildBrief(store, 'cc:0f3a1b11', { to: 'codex', checkIn: false }).text;
    assert.match(t, /3\. Then carry on with the next step\./);
    assert.doesNotMatch(t, /go-ahead/);
  });

  it('words a same-tool handoff as a fresh session', () => {
    const t = buildBrief(store, 'cc:0f3a1b11', { to: 'claude-code' }).text;
    assert.match(t, /from an earlier Claude Code session/);
  });

  it('keeps a given handoff id and rejects malformed ones', () => {
    assert.equal(buildBrief(store, 'cc:0f3a1b11', { to: 'codex', handoffId: 'hf_0123456789' }).handoffId, 'hf_0123456789');
    assert.notEqual(buildBrief(store, 'cc:0f3a1b11', { to: 'codex', handoffId: '../../etc' }).handoffId, '../../etc');
  });

  it('refuses tools it cannot start', () => {
    assert.throws(() => buildBrief(store, 'cc:0f3a1b11', { to: 'gemini' }), /Can't hand off/);
  });

  it('links the new session to the one it continues, across tools', async () => {
    const brief = buildBrief(store, 'cc:0f3a1b11', { to: 'codex' });
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
    writeCodexSession(s.codex, id, brief.text);
    await indexSources(store, cfg.sources);

    const target = store.resolve(`codex:${id}`);
    assert.equal(target.handoffFrom, SOURCE);
    assert.equal(target.handoffId, brief.handoffId);
    assert.equal(target.title, 'Continue: Move auth from localStorage tokens to httpOnly session cookies');

    assert.equal(store.related(SOURCE)[0]?.reason, 'continued-in');
    assert.equal(store.related(SOURCE)[0]?.session.id, target.id);
    assert.equal(store.related(target.id)[0]?.reason, 'continued-from');

    const g = store.workstreams();
    assert.equal(g.sessionWorkstream[target.id], g.sessionWorkstream[SOURCE], 'same workstream');
    assert.ok(g.edges.some((e) => e.kind === 'handoff' && e.a === SOURCE && e.b === target.id));
  });

  it('keeps the link when the index is rebuilt from scratch', async () => {
    store.close();
    rmSync(cfg.dbPath, { force: true });
    rmSync(`${cfg.dbPath}-wal`, { force: true });
    rmSync(`${cfg.dbPath}-shm`, { force: true });
    store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
    assert.equal(store.resolve('codex:aaaaaaaa-bbbb-4ccc-8ddd-000000000001').handoffFrom, SOURCE);
  });

  it('carries the original goal through a second handoff', async () => {
    const second = buildBrief(store, 'codex:aaaaaaaa-bbbb-4ccc-8ddd-000000000001', { to: 'claude-code' });
    assert.match(second.text, /## The goal\n\nOur auth stores the JWT in localStorage/);
    assert.match(second.text, /handed over before/);
    assert.doesNotMatch(second.text.split('## The goal')[1] ?? '', /## The goal/, 'no brief nested inside a brief');
  });

  it('stays within the size budget for very long sessions', async () => {
    const long = 'x'.repeat(5_000);
    const lines = [];
    for (let i = 0; i < 40; i++) {
      lines.push(JSON.stringify({ type: 'user', sessionId: 'b1b1b1b1-0000-4000-8000-000000000000', cwd: '/w', timestamp: `2026-10-29T00:${String(i).padStart(2, '0')}:00Z`, message: { role: 'user', content: `instruction ${i} ${long}` } }));
      lines.push(JSON.stringify({ type: 'assistant', sessionId: 'b1b1b1b1-0000-4000-8000-000000000000', cwd: '/w', timestamp: `2026-10-29T00:${String(i).padStart(2, '0')}:30Z`, message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `reply ${i} ${long}` }, { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `run ${i} ${long}` } }] } }));
    }
    const dir = join(s.claude, 'projects/-w');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'b1b1b1b1-0000-4000-8000-000000000000.jsonl'), lines.join('\n') + '\n');
    await indexSources(store, cfg.sources);
    const b = buildBrief(store, 'b1b1b1b1-0000-4000-8000-000000000000', { to: 'codex' });
    assert.ok(b.text.length <= MAX_BRIEF_CHARS, `brief is ${b.text.length} chars`);
    assert.ok(parseHandoffMarker(b.text), 'marker survives trimming');
    assert.match(b.text, /earlier instructions not shown/);
  });

  it('saves briefs where only you can read them', () => {
    const path = saveBrief(cfg.home, 'hf_0123456789', 'hello');
    assert.equal(readFileSync(path, 'utf8'), 'hello');
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(cfg.home, 'handoffs')).mode & 0o777, 0o700);
    }
    assert.throws(() => saveBrief(cfg.home, '../escape', 'x'), /Invalid handoff id/);
  });

  it('checks edited briefs before launch', () => {
    assert.throws(() => finalizeBrief('   ', 'hf_0123456789', SOURCE), /empty/);
    assert.throws(() => finalizeBrief('x'.repeat(200_001), 'hf_0123456789', SOURCE), /too long/);
    assert.deepEqual(parseHandoffMarker(finalizeBrief('# Mine\nedited', 'hf_0123456789', SOURCE)), { id: 'hf_0123456789', from: SOURCE });
  });

  it(
    'passes the brief to the tool as one argument, never as shell code',
    { skip: process.platform === 'win32' && 'needs a POSIX shell' },
    () => {
      // A fake `codex` that records the arguments it was given
      const bin = join(s.dir, 'bin');
      mkdirSync(bin, { recursive: true });
      const record = join(s.dir, 'args.json');
      writeFileSync(
        join(bin, 'codex'),
        `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n`,
      );
      chmodSync(join(bin, 'codex'), 0o755);

      const project = join(s.dir, "it's a project");
      mkdirSync(project, { recursive: true });
      const nasty = `# Continue: x\nQuotes ' " and $(touch ${join(s.dir, 'pwned')}) and \`touch ${join(s.dir, 'pwned2')}\` and $HOME\n`;
      const path = saveBrief(join(s.dir, "home with 'quote"), 'hf_0123456789', nasty);
      const line = startLine(codexAdapter, project, path);

      const r = spawnSync('bash', ['-c', line], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const got = JSON.parse(readFileSync(record, 'utf8'));
      assert.equal(got.args.length, 1);
      assert.equal(got.args[0], nasty.replace(/\n$/, ''), 'exact text (the shell only drops the final newline)');
      assert.equal(got.cwd, project);
      assert.throws(() => statSync(join(s.dir, 'pwned')));
      assert.throws(() => statSync(join(s.dir, 'pwned2')));
    },
  );

  it('starts in the current folder when the project folder is gone', () => {
    assert.equal(startLine(codexAdapter, '/definitely/not/here', '/tmp/b.md'), `codex "$(cat /tmp/b.md)"`);
  });
});
