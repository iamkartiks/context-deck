import assert from 'node:assert/strict';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  addDecision,
  cleanDecisionText,
  confirmDecision,
  decisionMatches,
  decisionsForChain,
  decisionsPath,
  deleteDecision,
  loadDecisions,
  resolveDecisions,
  restoreDecision,
  sanitizeDecisions,
  updateDecision,
} from '../src/decisions.js';
import { buildBrief } from '../src/handoff.js';
import { indexSources } from '../src/indexer.js';
import { Store } from '../src/store.js';
import { scratch } from './helpers.js';

const QW = 'qwen-code:5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61';
const QW_FILE = 'projects/-Users-alice-code-acme-shop/chats/5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61.jsonl';

describe('decision file', () => {
  it('keeps valid entries and drops the rest', () => {
    const ok = { id: 'd_0123456789', sessionId: QW, seq: 3, text: ' Use a sliding window ', messageHash: 'a'.repeat(32), createdAt: '2026-10-29T00:00:00.000Z' };
    const file = sanitizeDecisions({
      decisions: [
        ok,
        { ...ok }, // duplicate id
        { ...ok, id: '../x' },
        { ...ok, id: 'd_aaaaaaaaaa', seq: -1 },
        { ...ok, id: 'd_bbbbbbbbbb', text: '   ' },
        { ...ok, id: 'd_cccccccccc', messageHash: 'nothex' },
        'junk',
      ],
    });
    assert.equal(file.decisions.length, 1);
    assert.equal(file.decisions[0]!.text, 'Use a sliding window');
    assert.equal(file.decisions[0]!.updatedAt, ok.createdAt);
    assert.deepEqual(sanitizeDecisions(null).decisions, []);
    assert.deepEqual(sanitizeDecisions({ decisions: 'nope' }).decisions, []);
  });

  it('keeps a replacement only when it exists, and a valid check time', () => {
    const base = { sessionId: QW, seq: 3, text: 'x', messageHash: 'a'.repeat(32), createdAt: '2026-10-29T00:00:00.000Z' };
    const file = sanitizeDecisions({
      decisions: [
        { ...base, id: 'd_0000000001', replacedBy: 'd_0000000002', checkedAt: '2026-10-30T00:00:00.000Z' },
        { ...base, id: 'd_0000000002' },
        { ...base, id: 'd_0000000003', replacedBy: 'd_ffffffffff', checkedAt: 'yesterday' },
        { ...base, id: 'd_0000000004', replacedBy: 'd_0000000004' },
      ],
    });
    const [a, b, c, d] = file.decisions;
    assert.equal(a!.replacedBy, 'd_0000000002');
    assert.equal(a!.checkedAt, '2026-10-30T00:00:00.000Z');
    assert.equal(b!.replacedBy, undefined);
    assert.equal(c!.replacedBy, undefined, 'a missing replacement makes it current again');
    assert.equal(c!.checkedAt, undefined);
    assert.equal(d!.replacedBy, undefined, 'never replaced by itself');
  });

  it('tidies text and caps its length', () => {
    assert.equal(cleanDecisionText('a\r\n\r\n\r\n\r\nb'), 'a\n\nb');
    assert.equal(cleanDecisionText('x'.repeat(5000)).length, 2000);
  });
});

describe('decisions', () => {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
  let store: Store;

  before(async () => {
    store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
  });
  after(() => {
    store.close();
    s.cleanup();
  });

  const seqOf = (session: string, words: string) => store.matchesIn(store.resolve(session).id, words)[0]!.seq;

  it('pins a message, owner-only, outside the index', () => {
    const seq = seqOf(QW, '"Retry-After"');
    const d = addDecision(cfg.home, store, { sessionId: 'qw:3c4d5e61', seq, text: '429s carry Retry-After' });
    assert.match(d.id, /^d_[0-9a-f]{10}$/);
    assert.equal(d.sessionId, QW, 'short ids are stored as full ids');
    assert.deepEqual(
      loadDecisions(cfg.home).decisions.map((x) => x.text),
      ['429s carry Retry-After'],
    );
    if (process.platform !== 'win32') assert.equal(statSync(decisionsPath(cfg.home)).mode & 0o777, 0o600);
  });

  it('refuses bad input with a readable message', () => {
    assert.throws(() => addDecision(cfg.home, store, { sessionId: 'nope', seq: 0, text: 'x' }), /No session matches/);
    assert.throws(() => addDecision(cfg.home, store, { sessionId: QW, seq: 99_999, text: 'x' }), /not in this session/);
    assert.throws(() => addDecision(cfg.home, store, { sessionId: QW, seq: 0, text: '  ' }), /Write the decision/);
  });

  it('edits and removes', () => {
    const [d] = loadDecisions(cfg.home).decisions;
    assert.equal(updateDecision(cfg.home, d!.id, 'Every 429 carries Retry-After').text, 'Every 429 carries Retry-After');
    assert.throws(() => updateDecision(cfg.home, 'd_ffffffffff', 'x'), /No such decision/);
    const extra = addDecision(cfg.home, store, { sessionId: QW, seq: 0, text: 'temporary' });
    assert.equal(deleteDecision(cfg.home, extra.id), true);
    assert.equal(deleteDecision(cfg.home, extra.id), false);
    assert.equal(loadDecisions(cfg.home).decisions.length, 1);
  });

  it('matches every word, in the decision or its session title', () => {
    const [d] = resolveDecisions(store, loadDecisions(cfg.home).decisions);
    assert.equal(decisionMatches(d!, 'retry-after'), true);
    assert.equal(decisionMatches(d!, '429 "rate limiting"'), true, 'quotes are ignored; words can come from the title');
    assert.equal(decisionMatches(d!, 'retry postgres'), false);
  });

  it('finds the message again when positions shift, and keeps your words when it is gone', async () => {
    const before = resolveDecisions(store, loadDecisions(cfg.home).decisions)[0]!;
    assert.equal(before.anchored, true);
    const file = join(s.qwen, QW_FILE);
    const original = readFileSync(file, 'utf8');
    // A new first line pushes every message one place down
    const extra = JSON.stringify({ uuid: 'q-new', parentUuid: null, sessionId: QW.split(':')[1], timestamp: '2026-10-28T13:59:00.000Z', type: 'user', cwd: '/Users/alice/code/acme-shop', message: { role: 'user', parts: [{ text: 'An earlier note.' }] } });
    writeFileSync(file, `${extra}\n${original}`);
    const t = new Date(Date.now() + 5_000);
    utimesSync(file, t, t);
    await indexSources(store, cfg.sources);
    const moved = resolveDecisions(store, loadDecisions(cfg.home).decisions)[0]!;
    assert.equal(moved.anchored, true);
    assert.equal(moved.seq, before.seq + 1);
    assert.match(store.messageAt(QW, moved.seq)!.text, /Retry-After/);

    // Now the message disappears
    writeFileSync(file, original.split('\n').filter((l) => !l.includes('Also return a Retry-After header')).join('\n'));
    const t2 = new Date(Date.now() + 10_000);
    utimesSync(file, t2, t2);
    await indexSources(store, cfg.sources);
    const gone = resolveDecisions(store, loadDecisions(cfg.home).decisions)[0]!;
    assert.equal(gone.anchored, false);
    assert.equal(gone.text, 'Every 429 carries Retry-After', 'your words are kept');
  });

  it('goes into handoff briefs, from this session and the ones it continued', async () => {
    // Pin a decision on the Claude session, hand it to Codex, then hand the Codex session on
    const cc = store.resolve('cc:0f3a1b11');
    addDecision(cfg.home, store, { sessionId: cc.id, seq: seqOf(cc.id, 'httpOnly'), text: 'Sessions live in httpOnly cookies, not localStorage' });
    const first = buildBrief(store, cc.id, { to: 'codex', home: cfg.home });
    // Dated, and flagged: Codex and Qwen Code edited src/auth/session.ts after it, without this decision
    assert.match(
      first.text,
      /## Decisions already made\n\n- Sessions live in httpOnly cookies, not localStorage \(decided 2026-10-26\)\n  Since then, other sessions changed files it covers: src\/auth\/session\.ts\. Check it still holds\.\n/,
    );
    assert.match(first.text, /don't reopen the decisions above unless I ask\. Do check them against the code/);

    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000d1';
    const dir = join(s.codex, 'sessions/2026/10/29');
    const ev = (ts: string, type: string, payload: unknown) => JSON.stringify({ timestamp: ts, type, payload });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-10-29T07-00-00-${id}.jsonl`),
      [
        ev('2026-10-29T07:00:00Z', 'session_meta', { id, cwd: '/Users/alice/code/acme-shop' }),
        ev('2026-10-29T07:00:01Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: first.text }] }),
        ev('2026-10-29T07:00:09Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Picked it up.' }] }),
      ].join('\n') + '\n',
    );
    await indexSources(store, cfg.sources);
    const cx = store.resolve(`codex:${id}`);
    assert.equal(cx.handoffFrom, cc.id);
    addDecision(cfg.home, store, { sessionId: cx.id, seq: seqOf(cx.id, 'Picked'), text: 'Keep the refresh endpoint as is' });

    const chain = decisionsForChain(store, cfg.home, cx.id);
    assert.deepEqual(chain.map((d) => d.text), ['Sessions live in httpOnly cookies, not localStorage', 'Keep the refresh endpoint as is'], 'oldest first');
    const second = buildBrief(store, cx.id, { to: 'claude-code', home: cfg.home }).text;
    assert.match(
      second,
      /- Sessions live in httpOnly cookies, not localStorage \(decided 2026-10-26, in Claude Code\)\n  Since then, other sessions changed files it covers: src\/auth\/session\.ts\. Check it still holds\.\n- Keep the refresh endpoint as is \(decided 2026-10-29\)\n/,
    );
    assert.doesNotMatch(buildBrief(store, cx.id, { to: 'claude-code' }).text, /Decisions already made/, 'only when the folder is known');
  });
});

describe('decisions that may be out of date', () => {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
  let store: Store;
  const CC = 'claude-code:7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11';
  const CX = 'codex:019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701';

  before(async () => {
    store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
  });
  after(() => {
    store.close();
    s.cleanup();
  });

  const seqOf = (session: string, words: string) => store.matchesIn(store.resolve(session).id, words)[0]!.seq;
  const resolved = (id: string) => resolveDecisions(store, loadDecisions(cfg.home).decisions).find((d) => d.id === id)!;

  it('dates a decision by its message, and flags files that later sessions changed', () => {
    // Claude Code (Oct 26) edited cookies.ts and session.ts; Codex (Oct 27) and Qwen Code (Oct 28) edited session.ts after
    const d = addDecision(cfg.home, store, { sessionId: CC, seq: seqOf(CC, 'httpOnly'), text: 'Sessions live in httpOnly cookies' });
    const r = resolved(d.id);
    assert.match(r.decidedAt, /^2026-10-26T/, 'when it was said, not when it was marked');
    assert.deepEqual(r.changes.map((c) => c.path), ['/Users/alice/code/acme-shop/src/auth/session.ts']);
    assert.deepEqual(
      r.changes[0]!.sessions.map((x) => store.resolve(x.id).shortId),
      ['qw:3c4d5e61', 'cx:d5e6f701'],
      'newest first',
    );
  });

  it('does not count edits from before the decision, or from sessions that had it', () => {
    // The Codex session's own decision: only Qwen Code edited session.ts after it
    const d = addDecision(cfg.home, store, { sessionId: CX, seq: 0, text: 'Refresh tokens rotate on every use' });
    const r = resolved(d.id);
    assert.deepEqual(
      r.changes.flatMap((c) => c.sessions.map((x) => store.resolve(x.id).shortId)),
      ['qw:3c4d5e61'],
      'Claude Code edited it before; Codex is where it was decided',
    );
  });

  it('clears the flag when you say it still holds, until the files change again', async () => {
    const [d] = loadDecisions(cfg.home).decisions.filter((x) => x.text === 'Sessions live in httpOnly cookies');
    const checked = confirmDecision(cfg.home, d!.id);
    assert.ok(checked.checkedAt);
    assert.deepEqual(resolved(d!.id).changes, []);
    assert.throws(() => confirmDecision(cfg.home, 'd_ffffffffff'), /No such decision/);

    // A new session edits session.ts after the check: flagged again
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000e1';
    const dir = join(s.codex, 'sessions/2099/01/01');
    const ev = (ts: string, type: string, payload: unknown) => JSON.stringify({ timestamp: ts, type, payload });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2099-01-01T07-00-00-${id}.jsonl`),
      [
        ev('2099-01-01T07:00:00Z', 'session_meta', { id, cwd: '/Users/alice/code/acme-shop' }),
        ev('2099-01-01T07:00:01Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Store sessions in localStorage again' }] }),
        ev('2099-01-01T07:00:05Z', 'response_item', {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'c1',
          input: '*** Begin Patch\n*** Update File: src/auth/session.ts\n@@\n-a\n+b\n*** End Patch',
        }),
      ].join('\n') + '\n',
    );
    await indexSources(store, cfg.sources);
    const again = resolved(d!.id).changes;
    assert.deepEqual(again.flatMap((c) => c.sessions.map((x) => x.id)), [`codex:${id}`]);
    assert.equal(again[0]!.sessions[0]!.editedAt, '2099-01-01T07:00:05Z');
  });

  it('replaces a decision: the old one leaves briefs, and comes back if the new one goes', () => {
    const [old] = loadDecisions(cfg.home).decisions.filter((x) => x.text === 'Sessions live in httpOnly cookies');
    const qw = store.resolve('qw:3c4d5e61');
    const next = addDecision(cfg.home, store, { sessionId: qw.id, seq: seqOf(qw.id, '"Retry-After"'), text: 'Sessions live in httpOnly cookies, rotated hourly', replaces: old!.id });
    assert.equal(resolved(old!.id).replacedBy, next.id);
    assert.deepEqual(resolved(old!.id).changes, [], 'a replaced decision is not flagged');
    assert.throws(
      () => addDecision(cfg.home, store, { sessionId: qw.id, seq: 0, text: 'again', replaces: old!.id }),
      /already replaced/,
    );
    assert.throws(() => addDecision(cfg.home, store, { sessionId: qw.id, seq: 0, text: 'x', replaces: 'd_ffffffffff' }), /no longer exists/);

    // The brief from the Claude Code session carries the replacement instead, dated and placed
    const brief = buildBrief(store, CC, { to: 'codex', home: cfg.home }).text;
    assert.doesNotMatch(brief, /- Sessions live in httpOnly cookies \(/);
    assert.match(brief, /- Sessions live in httpOnly cookies, rotated hourly \(decided 2026-10-28, in Qwen Code\)/);

    // Removing the replacement makes the old one current again; so does Restore
    deleteDecision(cfg.home, next.id);
    assert.equal(resolved(old!.id).replacedBy, undefined);
    const again = addDecision(cfg.home, store, { sessionId: qw.id, seq: 0, text: 'Another take', replaces: old!.id });
    assert.equal(resolved(old!.id).replacedBy, again.id);
    restoreDecision(cfg.home, old!.id);
    assert.equal(resolved(old!.id).replacedBy, undefined);
  });
});
