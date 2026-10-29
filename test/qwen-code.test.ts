import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { qwenCodeAdapter } from '../src/adapters/qwen-code.js';
import type { SessionRow } from '../src/schema.js';
import { QW_DEEPSEEK, QW_MAIN, QW_SUBAGENT, QWEN_FIXTURES } from './helpers.js';

describe('Qwen Code adapter', () => {
  it('finds sessions and subagents, and nothing else', async () => {
    const files = await qwenCodeAdapter.discover(QWEN_FIXTURES);
    assert.deepEqual(files.sort(), [QW_MAIN, QW_SUBAGENT, QW_DEEPSEEK].sort(), 'no .runtime.json or .meta.json files');
    assert.deepEqual(await qwenCodeAdapter.discover('/definitely/not/here'), []);
  });

  it('looks where Qwen Code writes', () => {
    assert.equal(qwenCodeAdapter.defaultRoot({}, '/home/a'), '/home/a/.qwen');
    assert.equal(qwenCodeAdapter.defaultRoot({ QWEN_HOME: '/q' }, '/home/a'), '/q');
    assert.equal(qwenCodeAdapter.defaultRoot({ QWEN_HOME: '/q', QWEN_RUNTIME_DIR: '/rt' }, '/home/a'), '/rt', 'sessions follow the runtime folder');
    assert.equal(qwenCodeAdapter.defaultRoot({ QWEN_HOME: '/q', CONTEXTDECK_QWEN_DIR: '/mine' }, '/home/a'), '/mine');
  });

  it('parses session metadata', async () => {
    const { session: s, badLines } = await qwenCodeAdapter.parse(QW_MAIN);
    assert.ok(s);
    assert.equal(badLines, 1, 'the truncated line is skipped and counted');
    assert.equal(s.provider, 'qwen-code');
    assert.equal(s.nativeId, '5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61');
    assert.equal(s.cwd, '/Users/alice/code/acme-shop');
    assert.equal(s.gitBranch, 'feature/rate-limit');
    assert.equal(s.model, 'qwen3-coder:30b');
    assert.equal(s.cliVersion, '0.26.3');
    assert.equal(s.startedAt, '2026-10-28T14:00:00.000Z');
    assert.equal(s.updatedAt, '2026-10-28T14:03:22.000Z');
    assert.equal(s.title, 'Add rate limiting to the login endpoint: at most 5 attempts per minute per IP.');
    assert.equal(s.isSubagent, false);
  });

  it('counts real prompts, replies and tool calls', async () => {
    const { session: s } = await qwenCodeAdapter.parse(QW_MAIN);
    assert.equal(s?.userTurns, 2, 'notifications are not prompts');
    assert.equal(s?.assistantTurns, 4);
    assert.equal(s?.toolCalls, 4);
    const users = s!.messages.filter((m) => m.role === 'user').map((m) => m.text);
    assert.deepEqual(users, [
      'Add rate limiting to the login endpoint: at most 5 attempts per minute per IP.',
      '/compress',
      'Also return a Retry-After header.',
    ]);
    assert.ok(!s!.messages.some((m) => m.text.includes('internal reasoning')), 'reasoning is not indexed');
    assert.ok(s!.messages.some((m) => m.role === 'tool' && m.text === 'run_shell_command: $ npm test -- rate-limit'));
    assert.ok(s!.messages.some((m) => m.role === 'tool' && m.text.startsWith('read_file result: export async function login')));
  });

  it('reads tokens, the context window and compactions', async () => {
    const { session: s } = await qwenCodeAdapter.parse(QW_MAIN);
    assert.equal(s?.tokensIn, 9100 + 9800 + 2600 + 3100);
    assert.equal(s?.tokensOut, 120 + 40 + 300 + 80 + 60, 'reasoning tokens are output');
    assert.deepEqual(s?.contextSeries, [9220, 10100, 2680, 3160]);
    assert.equal(s?.contextTokens, 3160);
    assert.equal(s?.contextWindow, 262144);
    assert.equal(s?.compactions, 1);
    assert.deepEqual(s?.compactionPoints, [2]);
  });

  it('lists the files it wrote or edited', async () => {
    const { session: s } = await qwenCodeAdapter.parse(QW_MAIN);
    assert.deepEqual(s?.filesTouched, ['/Users/alice/code/acme-shop/src/auth/rate-limit.ts', '/Users/alice/code/acme-shop/src/auth/session.ts']);
  });

  it('links subagents to their session', async () => {
    const { session: s } = await qwenCodeAdapter.parse(QW_SUBAGENT);
    assert.equal(s?.isSubagent, true);
    assert.equal(s?.parentNativeId, '5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61');
    assert.equal(s?.nativeId, '5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61/agent-explore-7f3c');
    assert.equal(s?.title, 'Find every place that reads the auth cookie.');
    assert.equal(s?.userTurns, 1, 'the launch prompt is recorded twice; counted once');
  });

  it('uses a /rename title and works for any model (DeepSeek here)', async () => {
    const { session: s } = await qwenCodeAdapter.parse(QW_DEEPSEEK);
    assert.equal(s?.title, 'RSS feed for the blog');
    assert.equal(s?.model, 'deepseek-chat');
    assert.equal(s?.contextWindow, 131072);
    assert.deepEqual(s?.filesTouched, ['/Users/alice/code/blog/scripts/rss.mjs']);
  });

  it('resumes with qwen --resume, and starts handoffs interactively', () => {
    const row = { nativeId: 'abc-1', cwd: '/w/p', isSubagent: false, parentId: null } as unknown as SessionRow;
    assert.deepEqual(qwenCodeAdapter.resumeCommand(row), { command: 'qwen', args: ['--resume', 'abc-1'], cwd: '/w/p', display: 'cd /w/p && qwen --resume abc-1' });
    const sub = { nativeId: 'abc-1/agent-x', cwd: null, isSubagent: true, parentId: 'qwen-code:abc-1' } as unknown as SessionRow;
    assert.deepEqual(qwenCodeAdapter.resumeCommand(sub).args, ['--resume', 'abc-1'], 'a subagent resumes its parent');
    assert.deepEqual(qwenCodeAdapter.startCommand?.(), { command: 'qwen', args: ['-i'] }, '-i keeps the session open after the first prompt');
  });
});
