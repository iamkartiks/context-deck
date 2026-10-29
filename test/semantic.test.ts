import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { addDecision } from '../src/decisions.js';
import { checkAllowed, createEmbedder, EmbedError, embedderKey, formatFor, shapeVector } from '../src/embedder.js';
import { indexSources } from '../src/indexer.js';
import { catchUp, combine, piecesOf, searchByMeaning } from '../src/semantic.js';
import { defaultSettings, isLocalUrl, loadSettings, sanitizeSettings, saveSettings, settingsPath, type SemanticSettings } from '../src/settings.js';
import { Store } from '../src/store.js';
import { REPO, scratch, startFakeModelServer, type FakeModelServer } from './helpers.js';

const DB_SESSION = 'dddddddd-0000-4000-8000-00000000db01';

/** A session where a database was chosen without ever using the word "decided" or "database". */
function writeDatabaseSession(claudeRoot: string): string {
  const dir = join(claudeRoot, 'projects/-Users-alice-code-jobs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${DB_SESSION}.jsonl`);
  const line = (o: object) => JSON.stringify({ sessionId: DB_SESSION, cwd: '/Users/alice/code/jobs', ...o });
  writeFileSync(
    file,
    [
      line({ type: 'user', uuid: 'u1', timestamp: '2026-10-20T10:00:00Z', message: { role: 'user', content: 'Where should the job queue keep its state?' } }),
      line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-20T10:00:05Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: "Let's go with Postgres. SQLite locks the whole file on every write." }] } }),
    ].join('\n') + '\n',
  );
  return file;
}

describe('settings', () => {
  it('starts off, and only accepts sensible values', () => {
    assert.equal(defaultSettings().semantic.enabled, false);
    const s = sanitizeSettings({ semantic: { enabled: true, api: 'openai', model: 'bge-m3', dims: 256, url: 'javascript:alert(1)', allowRemote: 'yes' } });
    assert.equal(s.semantic.enabled, true);
    assert.equal(s.semantic.api, 'openai');
    assert.equal(s.semantic.url, 'http://127.0.0.1:1234', 'bad URL falls back to the default for that API');
    assert.equal(s.semantic.dims, 256);
    assert.equal(s.semantic.allowRemote, false);
    assert.equal(sanitizeSettings({ semantic: { model: 'a b; rm -rf' } }).semantic.model, 'qwen3-embedding:0.6b');
    assert.equal(sanitizeSettings({ semantic: { url: 'http://user:pw@127.0.0.1:1' } }).semantic.url, 'http://127.0.0.1:11434', 'no credentials in URLs');
    assert.equal(defaultSettings().semantic.minScore, null, 'the model default unless you set one');
    assert.equal(sanitizeSettings({ semantic: { minScore: 0.42 } }).semantic.minScore, 0.42);
    assert.equal(sanitizeSettings({ semantic: { minScore: 3 } }).semantic.minScore, null);
  });

  it('saves owner-only', () => {
    const s = scratch();
    try {
      const st = defaultSettings();
      st.semantic.enabled = true;
      saveSettings(s.home, st);
      assert.equal(loadSettings(s.home).semantic.enabled, true);
      if (process.platform !== 'win32') assert.equal(statSync(settingsPath(s.home)).mode & 0o777, 0o600);
    } finally {
      s.cleanup();
    }
  });

  it('knows which addresses are this computer', () => {
    for (const u of ['http://127.0.0.1:11434', 'http://localhost:1234', 'http://[::1]:8080', 'http://127.1.2.3']) assert.equal(isLocalUrl(u), true, u);
    for (const u of ['http://192.168.1.5:11434', 'https://api.example.com', 'http://localhost.evil.com', 'nonsense']) assert.equal(isLocalUrl(u), false, u);
  });
});

describe('embedder', () => {
  let server: FakeModelServer;
  const settings = (over: Partial<SemanticSettings> = {}): SemanticSettings => ({ ...defaultSettings().semantic, enabled: true, url: server.url, dims: 0, ...over });

  before(async () => {
    server = await startFakeModelServer();
  });
  after(() => server.close());

  it('words queries the way each model expects', () => {
    assert.match(formatFor('qwen3-embedding:0.6b', 'query', 'q'), /^Instruct: .+\nQuery:q$/);
    assert.equal(formatFor('qwen3-embedding:0.6b', 'document', 'd'), 'd');
    assert.equal(formatFor('embeddinggemma', 'document', 'd'), 'title: none | text: d');
    assert.equal(formatFor('nomic-embed-text', 'query', 'q'), 'search_query: q');
    assert.equal(formatFor('bge-m3', 'query', 'q'), 'q');
  });

  it('shortens and normalises vectors', () => {
    const v = shapeVector([3, 4, 12, 99], 2);
    assert.deepEqual([...v].map((x) => +x.toFixed(3)), [0.6, 0.8]);
    assert.equal(shapeVector([1, 2, 3], 0).length, 3);
  });

  it('talks to Ollama and to OpenAI-style servers, in order', async () => {
    const texts = ['Postgres it is', 'rss feed', 'login cookie'];
    const a = await createEmbedder(settings()).embed(texts, 'document');
    const b = await createEmbedder(settings({ api: 'openai' })).embed(texts, 'document');
    assert.equal(a.length, 3);
    assert.deepEqual(a.map((v) => [...v]), b.map((v) => [...v]), 'the OpenAI reply arrives reversed and is put back in order');
    assert.deepEqual(server.calls.map((c) => c.path), ['/api/embed', '/v1/embeddings']);
    assert.equal(embedderKey(settings({ dims: 256 })), 'ollama:qwen3-embedding:0.6b@256');
  });

  it('explains what to do when something is missing', async () => {
    await assert.rejects(createEmbedder(settings({ model: 'not-pulled' })).embed(['x'], 'query'), /Run: ollama pull not-pulled/);
    await assert.rejects(createEmbedder(settings({ url: 'http://127.0.0.1:9' })).embed(['x'], 'query'), /Nothing is answering at http:\/\/127\.0\.0\.1:9\. Start Ollama/);
    assert.throws(() => checkAllowed(settings({ url: 'https://embeddings.example.com' })), EmbedError);
    assert.doesNotThrow(() => checkAllowed(settings({ url: 'https://embeddings.example.com', allowRemote: true })));
  });
});

describe('pieces', () => {
  it('keeps short messages whole and splits long ones with overlap', () => {
    assert.equal(piecesOf(3, 'Use Postgres.').length, 1);
    assert.deepEqual(piecesOf(0, '  '), []);
    const long = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');
    const parts = piecesOf(7, long);
    assert.ok(parts.length > 1 && parts.length <= 6);
    for (const p of parts) {
      assert.equal(long.slice(p.start!, p.start! + p.len!), p.text, 'start/len point at the text');
      assert.ok(p.len! <= 1200);
      assert.ok(p.start === 0 || long[p.start! - 1] === ' ', 'starts at a word');
      assert.ok(p.start! + p.len! === long.length || long[p.start! + p.len!] === ' ', 'ends at a word');
    }
    assert.ok(parts[1]!.start! < parts[0]!.start! + parts[0]!.len!, 'pieces overlap');
    assert.deepEqual(piecesOf(7, long).map((p) => p.ref), parts.map((p) => p.ref), 'refs are stable');
  });
});

describe('search by meaning', () => {
  const s = scratch();
  const cfg = loadConfig({ home: s.home, claudeDir: s.claude, codexDir: s.codex, qwenDir: s.qwen }, {});
  let store: Store;
  let server: FakeModelServer;
  let settings: SemanticSettings;
  let dbFile: string;

  before(async () => {
    server = await startFakeModelServer();
    settings = { ...defaultSettings().semantic, enabled: true, url: server.url };
    dbFile = writeDatabaseSession(s.claude);
    store = new Store(cfg.dbPath);
    await indexSources(store, cfg.sources);
  });
  after(async () => {
    store.close();
    await server.close();
    s.cleanup();
  });

  it('embeds every session once, newest first, and skips what has not changed', async () => {
    const seen: number[] = [];
    const first = await catchUp(store, createEmbedder(settings), cfg.home, { onProgress: (p) => seen.push(p.sessionsDone) });
    assert.equal(first.stopped, false);
    assert.equal(first.sessionsTotal, store.sessionsForEmbedding().length);
    assert.equal(first.sessionsDone, first.sessionsTotal);
    assert.ok(first.pieces > 10);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
    const stats = store.chunkStats(createEmbedder(settings).key);
    assert.equal(stats.pieces, first.pieces);
    assert.ok(server.calls.every((c) => !c.inputs.some((t) => /^(Bash|Read|Edit|shell|apply_patch|read_file)[: ]/.test(t))), 'tool output is not embedded');

    const before = server.calls.length;
    const again = await catchUp(store, createEmbedder(settings), cfg.home);
    assert.deepEqual([again.sessionsTotal, again.pieces], [0, 0]);
    assert.equal(server.calls.length, before, 'nothing sent to the model');
  });

  it('finds the session by meaning, not words', async () => {
    const embedder = createEmbedder(settings);
    const q = 'which chat decided on the database';
    assert.deepEqual(store.search(q), [], 'word search finds nothing');
    const meaning = await searchByMeaning(store, embedder, q, { home: cfg.home });
    assert.equal(meaning[0]?.sessionId, `claude-code:${DB_SESSION}`);
    assert.match(meaning[0]!.snippet, /Let's go with Postgres/);
    assert.equal(meaning[0]!.role, 'assistant');

    const hits = combine(store, store.search(q), meaning, 20);
    assert.equal(hits[0]?.session.id, `claude-code:${DB_SESSION}`);
    assert.equal(hits[0]?.via, 'meaning');
    assert.ok(hits.length <= 12, 'meaning alone adds only the closest few');
  });

  it('adds nothing by meaning when the best match is below the cutoff', async () => {
    const embedder = createEmbedder(settings);
    const q = 'which chat decided on the database';
    const meaning = await searchByMeaning(store, embedder, q, { home: cfg.home });
    const best = meaning[0]!.score;
    assert.equal(combine(store, [], meaning, 20, { minScore: best - 0.01 })[0]?.via, 'meaning');
    assert.deepEqual(combine(store, [], meaning, 20, { minScore: best + 0.01 }), [], 'nothing close enough');
    assert.equal(combine(store, [], meaning, 20, { minScore: 0, margin: 1, maxAdded: 3 }).length, 3, 'never more than maxAdded');
  });

  it('keeps word matches first and labels what meaning added', async () => {
    const embedder = createEmbedder(settings);
    const words = store.search('cookie');
    const hits = combine(store, words, await searchByMeaning(store, embedder, 'cookie', { home: cfg.home }), 20);
    assert.ok(words.every((w) => hits.some((h) => h.session.id === w.session.id)), 'every word match is kept');
    assert.ok(hits.slice(0, words.length).every((h) => h.via !== 'meaning'), 'word matches rank above meaning-only ones');
    assert.ok(hits.some((h) => h.via === 'both'));
  });

  it('only embeds the new part of a session that grew', async () => {
    const before = server.calls.flatMap((c) => c.inputs).length;
    appendFileSync(
      dbFile,
      JSON.stringify({ sessionId: DB_SESSION, cwd: '/Users/alice/code/jobs', type: 'user', uuid: 'u2', timestamp: '2026-10-20T10:01:00Z', message: { role: 'user', content: 'And keep a dead-letter table for failed jobs.' } }) + '\n',
    );
    const t = new Date(Date.now() + 5_000);
    utimesSync(dbFile, t, t);
    await indexSources(store, cfg.sources);
    const r = await catchUp(store, createEmbedder(settings), cfg.home);
    assert.equal(r.sessionsTotal, 1);
    const sent = server.calls.flatMap((c) => c.inputs).slice(before);
    assert.deepEqual(sent, ['And keep a dead-letter table for failed jobs.'], 'only the new message');
  });

  it('embeds decisions, and finds sessions through them', async () => {
    const cc = store.resolve('cc:0f3a1b11');
    const seq = store.matchesIn(cc.id, 'httpOnly')[0]!.seq;
    addDecision(cfg.home, store, { sessionId: cc.id, seq, text: 'Picked Postgres for the session store' });
    const r = await catchUp(store, createEmbedder(settings), cfg.home);
    assert.equal(r.sessionsTotal, 1, 'only the session with the new decision');
    const meaning = await searchByMeaning(store, createEmbedder(settings), 'which database did we choose for sessions', { home: cfg.home });
    const hit = meaning.find((m) => m.sessionId === cc.id)!;
    assert.equal(hit.kind, 'decision');
    assert.equal(hit.snippet, 'Picked Postgres for the session store');
  });

  it('can stop part-way and carry on later', async () => {
    store.dropChunks();
    const ctrl = new AbortController();
    const partial = await catchUp(store, createEmbedder(settings), cfg.home, {
      signal: ctrl.signal,
      onProgress: (p) => p.sessionsDone >= 2 && ctrl.abort(),
    });
    assert.equal(partial.stopped, true);
    assert.equal(partial.sessionsDone, 2);
    const rest = await catchUp(store, createEmbedder(settings), cfg.home);
    assert.equal(rest.sessionsTotal, partial.sessionsTotal - 2);
  });

  it('drops vectors for removed sessions and from other models', async () => {
    const key = createEmbedder(settings).key;
    rmSync(join(s.claude, 'projects/-Users-alice-code-jobs'), { recursive: true });
    await indexSources(store, cfg.sources);
    const other = { ...settings, model: 'nomic-embed-text' };
    const r = await catchUp(store, createEmbedder(other), cfg.home);
    assert.ok(r.removed > 0);
    assert.equal(store.chunkStats(key).pieces, 0, 'the old model is gone');
    assert.ok(!store.loadChunks(createEmbedder(other).key).some((c) => c.sessionId.includes(DB_SESSION)), 'removed session is gone');
  });
});

describe('search by meaning from the command line', () => {
  const s = scratch();
  let server: FakeModelServer;
  const BIN = join(REPO, 'bin/contextdeck.js');
  // Not spawnSync: the stand-in model server runs in this process and has to keep answering
  const run = (...args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      execFile(
        process.execPath,
        [BIN, '--home', s.home, '--claude-dir', s.claude, '--codex-dir', s.codex, '--qwen-dir', s.qwen, ...args],
        { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
        (err, out, errOut) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out, err: errOut }),
      );
    });

  before(async () => {
    server = await startFakeModelServer();
    writeDatabaseSession(s.claude);
    await run('index');
  });
  after(async () => {
    await server.close();
    s.cleanup();
  });

  it('is off until you turn it on, and says how', async () => {
    const r = await run('semantic');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Search by meaning: off\. .*\n  ollama pull qwen3-embedding:0\.6b\n  contextdeck semantic enable/);
    assert.match((await run('doctor')).out, /– Search by meaning: off/);
    assert.equal(server.calls.length, 0, 'nothing talks to a model while it is off');
    assert.equal(JSON.parse((await run('search', 'cookie', '--json')).out)[0].via, 'words');
  });

  it('refuses to turn on when the model is missing or the server is not local', async () => {
    const missing = await run('semantic', 'enable', '--url', server.url, '--model', 'qwen3-embedding:8b');
    assert.equal(missing.code, 1);
    assert.match(missing.err, /Run: ollama pull qwen3-embedding:8b/);
    const remote = await run('semantic', 'enable', '--url', 'http://10.0.0.5:11434');
    assert.equal(remote.code, 1);
    assert.match(remote.err, /isn't on this computer.*--allow-remote/);
    assert.match((await run('semantic')).out, /off/, 'nothing was saved');
  });

  it('turns on, embeds everything, and finds by meaning', async () => {
    const on = await run('semantic', 'enable', '--url', server.url, '--dims', '0');
    assert.equal(on.code, 0, on.err);
    assert.match(on.out, /✓ Search by meaning is on: qwen3-embedding:0\.6b/);
    assert.match(on.out, /✓ Done: \d+ pieces from \d+ sessions/);
    const st = JSON.parse((await run('semantic', '--json')).out);
    assert.equal(st.enabled, true);
    assert.ok(st.pieces > 0);

    const r = await run('search', 'which chat decided on the database');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /cc:0000db01 .*\n  assistant · by meaning: Let's go with Postgres/);
    const json = JSON.parse((await run('search', 'which chat decided on the database', '--json')).out);
    assert.equal(json[0].via, 'meaning');
    assert.match((await run('search', 'which chat decided on the database', '--words')).out, /No messages match/);
    assert.match((await run('doctor')).out, /✓ Search by meaning: qwen3-embedding:0\.6b/);
  });

  it('lets you set the cutoff, or go back to the model default', async () => {
    assert.equal((await run('semantic', 'enable', '--url', server.url, '--min-score', '0.33')).code, 0);
    assert.equal(JSON.parse((await run('semantic', '--json')).out).minScore, 0.33);
    assert.match((await run('semantic')).out, /cutoff 0\.33/);
    assert.equal((await run('semantic', 'enable', '--url', server.url, '--min-score', 'auto')).code, 0);
    assert.equal(JSON.parse((await run('semantic', '--json')).out).minScore, 0.1);
    assert.equal((await run('semantic', 'enable', '--min-score', '7')).code, 2);
  });

  it('keeps up as you index, and falls back to words when the model is away', async () => {
    const before = server.calls.length;
    assert.match((await run('index')).out, /unchanged/);
    assert.equal(server.calls.length, before, 'nothing new, nothing sent');
    await server.close();
    const r = await run('search', 'cookie');
    assert.equal(r.code, 0);
    assert.match(r.err, /Search by meaning unavailable \(Nothing is answering at/);
    assert.match(r.out, /cookie/i);
    assert.match((await run('doctor')).out, /✗ Search by meaning: .*Nothing is answering/);
    server = await startFakeModelServer(); // for after()
  });

  it('turns off, and can delete the vectors', async () => {
    assert.match((await run('semantic', 'disable')).out, /Vectors are kept/);
    assert.match((await run('semantic', 'disable', '--drop')).out, /Stored vectors deleted/);
    assert.equal(JSON.parse((await run('semantic', '--json')).out).pieces, 0);
  });
});
