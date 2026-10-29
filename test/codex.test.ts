import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as zlib from 'node:zlib';
import { codexAdapter } from '../src/adapters/codex.js';
import { zstdSupported } from '../src/util/jsonl.js';
import { CODEX_FIXTURES, CX_LEGACY, CX_MODERN } from './helpers.js';

describe('Codex adapter', () => {
  it('discovers rollout files', async () => {
    const files = await codexAdapter.discover(CODEX_FIXTURES);
    assert.deepEqual(files.sort(), [CX_LEGACY, CX_MODERN].sort());
  });

  it('parses session_meta and turn_context', async () => {
    const { session: s, badLines } = await codexAdapter.parse(CX_MODERN);
    assert.ok(s);
    assert.equal(badLines, 0);
    assert.equal(s.nativeId, '019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701');
    assert.equal(s.cwd, '/Users/alice/code/acme-shop');
    assert.equal(s.gitBranch, 'feature/session-cookies');
    assert.equal(s.model, 'gpt-5.5');
    assert.equal(s.cliVersion, '0.134.0');
  });

  it('ignores injected environment / permissions messages', async () => {
    const { session: s } = await codexAdapter.parse(CX_MODERN);
    assert.equal(s!.userTurns, 1);
    assert.match(s!.title, /^The session refresh tests fail/);
    assert.ok(!s!.messages.some((m) => m.text.includes('<environment_context>')));
  });

  it('does not double count text logged as both response_item and event_msg', async () => {
    const { session: s } = await codexAdapter.parse(CX_MODERN);
    const fixed = s!.messages.filter((m) => m.text.startsWith('Fixed: refresh()'));
    assert.equal(fixed.length, 1);
    assert.equal(s!.assistantTurns, 1);
  });

  it('reads cumulative tokens, context size and window', async () => {
    const { session: s } = await codexAdapter.parse(CX_MODERN);
    assert.equal(s!.tokensIn, 48_210);
    assert.equal(s!.tokensOut, 2_210);
    assert.equal(s!.contextTokens, 61_200 + 1_300);
    assert.equal(s!.contextWindow, 272_000);
    assert.equal(s!.compactions, 1);
  });

  it('records context size per token_count and compaction points', async () => {
    const { session: s } = await codexAdapter.parse(CX_MODERN);
    assert.deepEqual(s!.contextSeries, [62_500]);
    assert.deepEqual(s!.compactionPoints, [1]);
  });

  it('counts one compaction once, even when the older format records it twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cx-'));
    try {
      const p = join(dir, 'rollout-2026-01-01T00-00-00-11111111-2222-4333-8444-555555555556.jsonl');
      const ev = (ts: string, type: string, payload: unknown) => JSON.stringify({ timestamp: ts, type, payload });
      const tokens = (n: number) => ({ type: 'token_count', info: { last_token_usage: { input_tokens: n, output_tokens: 0 }, model_context_window: 272000 } });
      writeFileSync(
        p,
        [
          ev('2026-01-01T00:00:00Z', 'session_meta', { id: '11111111-2222-4333-8444-555555555556' }),
          ev('2026-01-01T00:00:01Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
          ev('2026-01-01T00:00:02Z', 'event_msg', tokens(200_000)),
          // One compaction, legacy style: a `compacted` record and a `context_compacted` event
          ev('2026-01-01T00:00:03Z', 'compacted', { message: 'summary' }),
          ev('2026-01-01T00:00:03Z', 'event_msg', { type: 'context_compacted' }),
          ev('2026-01-01T00:00:04Z', 'event_msg', tokens(30_000)),
          // A second compaction
          ev('2026-01-01T00:00:05Z', 'compacted', { message: 'summary' }),
          ev('2026-01-01T00:00:05Z', 'event_msg', { type: 'context_compacted' }),
          ev('2026-01-01T00:00:06Z', 'event_msg', tokens(20_000)),
        ].join('\n'),
      );
      const { session: s } = await codexAdapter.parse(p);
      assert.equal(s!.compactions, 2);
      assert.deepEqual(s!.compactionPoints, [1, 2]);

      // A file with only the events still counts them
      writeFileSync(
        p,
        [
          ev('2026-01-01T00:00:00Z', 'session_meta', { id: '11111111-2222-4333-8444-555555555556' }),
          ev('2026-01-01T00:00:01Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
          ev('2026-01-01T00:00:02Z', 'event_msg', { type: 'context_compacted' }),
        ].join('\n'),
      );
      assert.equal((await codexAdapter.parse(p)).session!.compactions, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts files from apply_patch calls and shell commands', async () => {
    const { session: s } = await codexAdapter.parse(CX_MODERN);
    assert.equal(s!.toolCalls, 2);
    assert.deepEqual(s!.filesTouched.sort(), ['src/auth/refresh.test.ts', 'src/auth/session.ts']);
    const shell = s!.messages.find((m) => m.toolName === 'shell' && m.role === 'tool');
    assert.equal(shell?.text, 'shell: $ npm test -- refresh');
  });

  it('parses the older un-wrapped rollout format', async () => {
    const { session: s } = await codexAdapter.parse(CX_LEGACY);
    assert.ok(s);
    assert.equal(s.nativeId, '3a4b5c6d-7e8f-4a1b-9c2d-0e1f2a3b4c5d');
    assert.equal(s.gitBranch, 'main');
    assert.equal(s.userTurns, 1);
    assert.equal(s.assistantTurns, 1);
    assert.match(s.title, /SQL migration/);
  });

  it('falls back to event_msg text when there are no response items', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cx-'));
    try {
      const p = join(dir, 'rollout-2026-01-01T00-00-00-11111111-2222-4333-8444-555555555555.jsonl');
      writeFileSync(
        p,
        [
          { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'hello from events' } },
          { timestamp: '2026-01-01T00:00:05Z', type: 'event_msg', payload: { type: 'agent_message', message: 'hi!' } },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n'),
      );
      const { session: s } = await codexAdapter.parse(p);
      assert.equal(s?.nativeId, '11111111-2222-4333-8444-555555555555', 'id falls back to the file name');
      assert.equal(s?.title, 'hello from events');
      assert.equal(s?.userTurns, 1);
      assert.equal(s?.messages.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads zstd-compressed rollouts', { skip: !zstdSupported() && 'no zstd in this Node' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cx-'));
    try {
      const day = join(dir, 'sessions/2026/10/27');
      mkdirSync(day, { recursive: true });
      const target = join(day, 'rollout-2026-10-27T08-30-00-019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701.jsonl.zst');
      const compress = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
      writeFileSync(target, compress(readFileSync(CX_MODERN)));

      const files = await codexAdapter.discover(dir);
      assert.deepEqual(files, [target]);
      const { session: s } = await codexAdapter.parse(target);
      assert.equal(s?.nativeId, '019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701');
      assert.equal(s?.userTurns, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds the resume command', async () => {
    const row = { nativeId: '019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701', cwd: '/Users/alice/code/acme-shop' } as Parameters<
      typeof codexAdapter.resumeCommand
    >[0];
    const cmd = codexAdapter.resumeCommand(row);
    assert.deepEqual([cmd.command, ...cmd.args], ['codex', 'resume', '019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701']);
    assert.equal(cmd.cwd, '/Users/alice/code/acme-shop');
  });
});
