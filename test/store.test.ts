import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { indexSources } from '../src/indexer.js';
import { DatabaseSync } from 'node:sqlite';
import { absoluteIn, downsampleSeries, Store, toFtsQuery } from '../src/store.js';
import { scratch } from './helpers.js';

describe('downsampleSeries', () => {
  it('leaves short series alone', () => {
    assert.deepEqual(downsampleSeries([1, 2, 3], [2], 10), { points: [1, 2, 3], compactions: [2] });
  });
  it('keeps the last value of each bucket and moves compaction marks with it', () => {
    const points = Array.from({ length: 1000 }, (_, i) => i);
    const out = downsampleSeries(points, [500, 999], 100);
    assert.equal(out.points.length, 100);
    assert.equal(out.points[0], 9);
    assert.equal(out.points[99], 999, 'the final context size is always kept');
    assert.deepEqual(out.compactions, [50, 99]);
  });
  it('clamps bad marks instead of failing', () => {
    assert.deepEqual(downsampleSeries([5, 6], [-3, 99], 10).compactions, [0, 2]);
  });
});

describe('index size', () => {
  it('stores each message once, searches it, and gives space back when sessions go', async () => {
    const s = scratch();
    try {
      // Three large synthetic sessions (~1.5 MB of text each)
      const dir = join(s.claude, 'projects/-big');
      mkdirSync(dir, { recursive: true });
      const para = 'The payment module retries failed charges with exponential backoff and records each attempt. ';
      for (let n = 0; n < 3; n++) {
        const id = `bbbbbbbb-0000-4000-8000-00000000000${n}`;
        const lines = [];
        for (let t = 0; t < 250; t++) {
          lines.push(JSON.stringify({ type: 'user', sessionId: id, cwd: '/big', timestamp: '2026-10-29T00:00:00Z', message: { role: 'user', content: `step ${t} uniqueword${n}x${t} ${para.repeat(20)}` } }));
          lines.push(JSON.stringify({ type: 'assistant', sessionId: id, cwd: '/big', timestamp: '2026-10-29T00:00:01Z', message: { id: `m${t}`, role: 'assistant', content: [{ type: 'text', text: para.repeat(40) }] } }));
        }
        writeFileSync(join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
      }
      const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
      const store = new Store(cfg.dbPath);
      await indexSources(store, cfg.sources);

      // No second copy of the text in the search index
      const db = new DatabaseSync(cfg.dbPath);
      const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'messages_fts%'`).all() as { name: string }[]).map((r) => r.name);
      assert.ok(!tables.includes('messages_fts_content'), tables.join(','));
      db.close();

      assert.equal(store.search('uniqueword1x7').length, 1);
      assert.match(store.search('uniqueword1x7')[0]!.snippet, /«uniqueword1x7»/);

      // Re-indexing a changed session leaves no stale search entries
      const file = join(dir, 'bbbbbbbb-0000-4000-8000-000000000001.jsonl');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/uniqueword1x7 /, 'replacedword ') );
      const later = new Date(Date.now() + 5000);
      utimesSync(file, later, later);
      await indexSources(store, cfg.sources);
      assert.equal(store.search('uniqueword1x7').length, 0);
      assert.equal(store.search('replacedword').length, 1);

      // Removing sessions hands the space back
      const before = statSync(cfg.dbPath).size;
      rmSync(join(dir, 'bbbbbbbb-0000-4000-8000-000000000000.jsonl'));
      rmSync(join(dir, 'bbbbbbbb-0000-4000-8000-000000000002.jsonl'));
      await indexSources(store, cfg.sources);
      const after = statSync(cfg.dbPath).size;
      assert.ok(after < before * 0.6, `index went from ${before} to ${after} bytes`);
      assert.equal(store.search('uniqueword0x3').length, 0);
      store.close();
    } finally {
      s.cleanup();
    }
  });
});

describe('index upgrade', () => {
  it('adds the context column to a v1 index and rebuilds it', async () => {
    const s = scratch();
    try {
      const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
      let store = new Store(cfg.dbPath);
      await indexSources(store, cfg.sources);
      store.close();

      // Turn it back into a v1 index
      const db = new DatabaseSync(cfg.dbPath);
      db.exec(`ALTER TABLE sessions DROP COLUMN context_series; UPDATE meta SET value = '1' WHERE key = 'schema_version';`);
      db.close();

      store = new Store(cfg.dbPath);
      assert.equal(store.stats().sessions, 0, 'cache cleared so every file is re-read');
      const sum = await indexSources(store, cfg.sources);
      assert.equal(sum.indexed, 8);
      assert.deepEqual(store.contextSeries(store.resolve('cc:0f3a1b11').id), { points: [16_500, 19_500, 44_000], compactions: [2] });
      store.close();

      // The upgraded file uses the compact layout
      const check = new DatabaseSync(cfg.dbPath);
      const one = (sql: string) => Object.values(check.prepare(sql).get() as Record<string, unknown>)[0];
      assert.equal(one('PRAGMA page_size'), 16384);
      assert.equal(one('PRAGMA auto_vacuum'), 2, 'incremental');
      assert.match(String(one(`SELECT sql FROM sqlite_master WHERE name = 'messages_fts'`)), /content = 'messages'/);
      check.close();
    } finally {
      s.cleanup();
    }
  });
});

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
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
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
    assert.equal(sum.scanned, 9);
    assert.equal(sum.indexed, 8);
    assert.equal(sum.empty, 1);
    assert.equal(sum.failed, 0);
    assert.equal(sum.badLines, 2);
  });

  it('is incremental: a second run parses nothing', async () => {
    const sum = await indexSources(store, cfg.sources);
    assert.equal(sum.indexed, 0);
    assert.equal(sum.unchanged, 9);
  });

  it('lists newest first and hides subagents unless asked', () => {
    const rows = store.listSessions();
    assert.equal(rows.length, 6);
    assert.equal(rows[0]!.provider, 'qwen-code');
    assert.ok(rows.every((r) => !r.isSubagent));
    assert.equal(store.listSessions({ includeSubagents: true }).length, 8);
  });

  it('filters by provider (id or short prefix) and project', () => {
    assert.equal(store.listSessions({ provider: 'cx' }).length, 2);
    assert.equal(store.listSessions({ provider: 'claude-code' }).length, 2);
    assert.equal(store.listSessions({ provider: 'qw' }).length, 2);
    assert.equal(store.listSessions({ project: 'acme-shop' }).length, 3);
    assert.equal(store.listSessions({ project: '/Users/alice/code/blog' }).length, 2);
  });

  it('searches across providers, best message per session', () => {
    const hits = store.search('cookie');
    assert.deepEqual(hits.map((h) => h.session.provider).sort(), ['claude-code', 'codex', 'qwen-code']);
    for (const h of hits) assert.match(h.snippet, /«cookie»/i);
    assert.equal(store.search('cookie', { provider: 'codex' }).length, 1);
    assert.equal(store.search('"refresh path"').length, 2);
    assert.equal(store.search('nonexistentword').length, 0);
  });

  it('shows a match in the conversation ahead of one in tool output', () => {
    // "cookies" is in a prompt and in file paths the agent edited
    const id = store.resolve('cc:0f3a1b11').id;
    assert.ok(store.matchesIn(id, 'cookies').some((m) => m.role === 'tool'), 'tool output matches too');
    const best = store.search('cookies', { provider: 'claude-code' }).find((h) => h.session.id === id)!;
    assert.notEqual(best.role, 'tool');
    assert.match(store.messageAt(id, best.seq)!.text, /cookie/i, 'stemming: "cookies" also finds "cookie"');
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
    assert.deepEqual(related.map((r) => [r.session.provider, r.reason]), [
      ['qwen-code', 'shared-files'],
      ['codex', 'shared-files'],
    ]);
    assert.deepEqual(related[1]?.sharedFiles, ['src/auth/session.ts'], 'Codex wrote a relative path');
  });

  it('groups projects across tools', () => {
    const projects = store.projects();
    const shop = projects.find((p) => p.project === 'acme-shop');
    assert.deepEqual(shop?.providers, ['claude-code', 'codex', 'qwen-code']);
    assert.equal(shop?.sessions, 3);
  });

  it('groups sessions into cross-tool workstreams', () => {
    const g = store.workstreams();
    const linked = g.workstreams.filter((w) => w.kind === 'linked');
    assert.equal(linked.length, 1);
    assert.equal(linked[0]!.label, 'session.ts', 'branches differ, so it is named after the shared file');
    assert.deepEqual(linked[0]!.providers, ['claude-code', 'codex', 'qwen-code']);
    assert.equal(linked[0]!.sessionIds.length, 3);
    // Every top-level session lands in exactly one group; subagents are left out
    const all = g.workstreams.flatMap((w) => w.sessionIds);
    assert.equal(all.length, 6);
    assert.equal(new Set(all).size, 6);
    assert.ok(!all.some((id) => id.includes('/agent-')));
    assert.equal(g.edges.length, 3, 'each pair of the three tools');
    for (const e of g.edges) assert.deepEqual(e.files, ['/Users/alice/code/acme-shop/src/auth/session.ts']);
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
    assert.equal(store.search('RSS', { provider: 'claude-code' }).length, 0);
    assert.equal(store.search('RSS', { provider: 'qwen-code' }).length, 1, 'other tools are untouched');
  });

  it('does not wipe the index when a whole source folder is missing', async () => {
    const missing = loadConfig({ home: s.home, claudeDir: '/nope/claude', codexDir: s.codex, qwenDir: s.qwen }, {});
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
