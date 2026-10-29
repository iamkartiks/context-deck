import assert from 'node:assert/strict';
import { appendFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { indexSources } from '../src/indexer.js';
import { absoluteIn, Store, toFtsQuery } from '../src/store.js';
import { scratch } from './helpers.js';

describe('absoluteIn', () => {
  it('resolves with the path style of the recorded cwd, whatever OS runs the index', () => {
    assert.equal(absoluteIn('/Users/a/shop', 'src/x.ts'), '/Users/a/shop/src/x.ts');
    assert.equal(absoluteIn('/Users/a/shop', '/Users/a/shop/./src/x.ts'), '/Users/a/shop/src/x.ts');
    assert.equal(absoluteIn('C:\\code\\shop', 'src\\x.ts'), 'C:\\code\\shop\\src\\x.ts');
    assert.equal(absoluteIn(null, 'src/x.ts'), 'src/x.ts');
  });
});

describe('toFtsQuery', () => {
  it('quotes words so punctuation cannot break FTS syntax', () => {
    assert.equal(toFtsQuery('session cookie'), '"session" "cookie"');
    assert.equal(toFtsQuery('src/auth-session.ts'), '"src/auth-session.ts"');
    assert.equal(toFtsQuery('say "hi" there'), '"say" "hi" "there"');
  });
  it('keeps phrases, prefixes and operators', () => {
    assert.equal(toFtsQuery('"refresh path" migrat*'), '"refresh path" "migrat"*');
    assert.equal(toFtsQuery('cookie OR token'), '"cookie" OR "token"');
  });
  it('drops dangling operators and empty input', () => {
    assert.equal(toFtsQuery('OR cookie AND'), '"cookie"');
    assert.equal(toFtsQuery('   '), '');
    assert.equal(toFtsQuery('""'), '');
  });
});

describe('Store + indexer', () => {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex }, {});
  let store: Store;

  before(() => {
    store = new Store(cfg.dbPath);
  });
  after(() => {
    store.close();
    s.cleanup();
  });

  it('indexes every fixture', async () => {
    const sum = await indexSources(store, cfg.sources);
    assert.equal(sum.scanned, 6);
    assert.equal(sum.indexed, 5);
    assert.equal(sum.empty, 1);
    assert.equal(sum.failed, 0);
    assert.equal(sum.badLines, 1);
  });

  it('is incremental: a second run parses nothing', async () => {
    const sum = await indexSources(store, cfg.sources);
    assert.equal(sum.indexed, 0);
    assert.equal(sum.unchanged, 6);
  });

  it('lists newest first and hides subagents unless asked', () => {
    const rows = store.listSessions();
    assert.equal(rows.length, 4);
    assert.equal(rows[0]!.provider, 'codex');
    assert.ok(rows.every((r) => !r.isSubagent));
    assert.equal(store.listSessions({ includeSubagents: true }).length, 5);
  });

  it('filters by provider (id or short prefix) and project', () => {
    assert.equal(store.listSessions({ provider: 'cx' }).length, 2);
    assert.equal(store.listSessions({ provider: 'claude-code' }).length, 2);
    assert.equal(store.listSessions({ project: 'acme-shop' }).length, 2);
    assert.equal(store.listSessions({ project: '/Users/alice/code/blog' }).length, 1);
  });

  it('searches across providers, best message per session', () => {
    const hits = store.search('cookie');
    assert.deepEqual(hits.map((h) => h.session.provider).sort(), ['claude-code', 'codex']);
    for (const h of hits) assert.match(h.snippet, /«cookie»/i);
    assert.equal(store.search('cookie', { provider: 'codex' }).length, 1);
    assert.equal(store.search('"refresh path"').length, 2);
    assert.equal(store.search('nonexistentword').length, 0);
  });

  it('survives hostile search input', () => {
    assert.doesNotThrow(() => store.search('foo" OR (bar'));
    assert.doesNotThrow(() => store.search('NEAR( * :'));
  });

  it('resolves short ids, prefixes and fragments', () => {
    assert.equal(store.resolve('cx:d5e6f701').nativeId, '019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701');
    assert.equal(store.resolve('019a2f3c').provider, 'codex');
    assert.equal(store.resolve('claude-code:7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11').title.startsWith('Move auth'), true);
    // The parent wins over its own subagent, which shares the id fragment
    assert.equal(store.resolve('7c1e2a90').isSubagent, false);
    assert.equal(store.resolve('cc:4e5f6a7b').isSubagent, true);
    assert.throws(() => store.resolve('zzzzzz'), /No session matches/);
  });

  it('reports ambiguous ids instead of guessing', () => {
    // "-4" appears in several unrelated native ids
    assert.throws(() => store.resolve('-4'), /matches more than one session/);
  });

  it('links sessions across tools by shared files (relative paths resolved against cwd)', () => {
    const claude = store.resolve('cc:0f3a1b11');
    const related = store.related(claude.id);
    assert.equal(related[0]?.session.provider, 'codex');
    assert.equal(related[0]?.reason, 'shared-files');
    assert.deepEqual(related[0]?.sharedFiles, ['src/auth/session.ts']);
  });

  it('groups projects across tools', () => {
    const projects = store.projects();
    const shop = projects.find((p) => p.project === 'acme-shop');
    assert.deepEqual(shop?.providers, ['claude-code', 'codex']);
    assert.equal(shop?.sessions, 2);
  });

  it('groups sessions into cross-tool workstreams', () => {
    const g = store.workstreams();
    const linked = g.workstreams.filter((w) => w.kind === 'linked');
    assert.equal(linked.length, 1);
    assert.equal(linked[0]!.label, 'session cookies', 'named after the shared feature branch');
    assert.deepEqual(linked[0]!.providers, ['claude-code', 'codex']);
    assert.equal(linked[0]!.sessionIds.length, 2);
    // Every top-level session lands in exactly one group; subagents are left out
    const all = g.workstreams.flatMap((w) => w.sessionIds);
    assert.equal(all.length, 4);
    assert.equal(new Set(all).size, 4);
    assert.ok(!all.some((id) => id.includes('/agent-')));
    assert.equal(g.edges.length, 1);
    assert.deepEqual(g.edges[0]!.files.sort(), ['/Users/alice/code/acme-shop/src/auth/session.ts']);
    assert.equal(g.sessionWorkstream[linked[0]!.sessionIds[0]!], linked[0]!.id);
  });

  it('returns messages in order, optionally only the last N and certain roles', () => {
    const id = store.resolve('cc:0f3a1b11').id;
    const last = store.messages(id, { last: 2, roles: ['user', 'assistant'] });
    assert.equal(last.length, 2);
    assert.ok(last[0]!.seq < last[1]!.seq);
    assert.match(last[1]!.text, /refresh path/);
  });

  it('re-parses a file when it grows', async () => {
    const file = join(s.codex, 'sessions/2026/10/27/rollout-2026-10-27T08-30-00-019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701.jsonl');
    appendFileSync(
      file,
      JSON.stringify({
        timestamp: '2026-10-27T09:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'now add zebra-striping to the table' }] },
      }) + '\n',
    );
    const future = new Date(Date.now() + 5_000);
    utimesSync(file, future, future);
    const sum = await indexSources(store, cfg.sources);
    assert.equal(sum.indexed, 1);
    assert.equal(store.search('zebra').length, 1);
    assert.equal(store.resolve('cx:d5e6f701').userTurns, 2);
    // Old messages were replaced, not duplicated
    assert.equal(store.search('"refresh path"', { provider: 'codex' })[0]?.hits, 1);
  });

  it('drops sessions whose files were deleted', async () => {
    rmSync(join(s.claude, 'projects/-Users-alice-code-blog'), { recursive: true });
    const sum = await indexSources(store, cfg.sources);
    assert.equal(sum.removed, 2);
    assert.throws(() => store.resolve('cc:9e8f7c22'), /No session matches/);
    assert.equal(store.search('RSS').length, 0);
  });

  it('does not wipe the index when a whole source folder is missing', async () => {
    const missing = loadConfig({ home: s.home, claudeDir: '/nope/claude', codexDir: s.codex }, {});
    const sum = await indexSources(store, missing.sources);
    assert.equal(sum.removed, 0);
    assert.ok(store.listSessions({ provider: 'cc' }).length > 0);
  });

  it('a full re-index keeps counts stable', async () => {
    const before = store.stats();
    await indexSources(store, cfg.sources, { full: true });
    const after = store.stats();
    assert.equal(after.sessions, before.sessions);
    assert.equal(after.messages, before.messages);
  });
});
