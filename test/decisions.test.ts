import assert from 'node:assert/strict';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  addDecision,
  cleanDecisionText,
  decisionMatches,
  decisionsForChain,
  decisionsPath,
  deleteDecision,
  loadDecisions,
  resolveDecisions,
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
    assert.match(first.text, /## Decisions already made\n\n- Sessions live in httpOnly cookies, not localStorage\n/);
    assert.match(first.text, /don't reopen the decisions above unless I ask/);

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
    assert.match(second, /- Sessions live in httpOnly cookies, not localStorage \(decided earlier, in Claude Code\)\n- Keep the refresh endpoint as is\n/);
    assert.doesNotMatch(buildBrief(store, cx.id, { to: 'claude-code' }).text, /Decisions already made/, 'only when the folder is known');
  });
});
