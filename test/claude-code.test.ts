import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CC_MAIN, CC_SNAPSHOT_ONLY, CC_SUBAGENT, CLAUDE_FIXTURES } from './helpers.js';

describe('Claude Code adapter', () => {
  it('discovers main sessions, subagents and empty files', async () => {
    const files = await claudeCodeAdapter.discover(CLAUDE_FIXTURES);
    assert.equal(files.length, 4);
    assert.ok(files.includes(CC_SUBAGENT));
  });

  it('returns [] when the folder does not exist', async () => {
    assert.deepEqual(await claudeCodeAdapter.discover('/definitely/not/here'), []);
  });

  it('parses session metadata', async () => {
    const { session: s, badLines } = await claudeCodeAdapter.parse(CC_MAIN);
    assert.ok(s);
    assert.equal(badLines, 1, 'the truncated line is skipped and counted');
    assert.equal(s.nativeId, '7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11');
    assert.equal(s.cwd, '/Users/alice/code/acme-shop');
    assert.equal(s.gitBranch, 'feature/session-cookies');
    assert.equal(s.model, 'claude-opus-4-5');
    assert.equal(s.cliVersion, '2.4.1');
    assert.equal(s.startedAt, '2026-10-26T09:58:00.000Z');
    assert.equal(s.updatedAt, '2026-10-26T10:07:45.000Z');
    assert.equal(s.isSubagent, false);
  });

  it('prefers the summary line as the title', async () => {
    const { session } = await claudeCodeAdapter.parse(CC_MAIN);
    assert.equal(session?.title, 'Move auth from localStorage tokens to httpOnly session cookies');
  });

  it('counts real prompts only (not meta, command wrappers or tool results)', async () => {
    const { session } = await claudeCodeAdapter.parse(CC_MAIN);
    assert.equal(session?.userTurns, 2);
  });

  it('counts usage once per streamed message', async () => {
    const { session: s } = await claudeCodeAdapter.parse(CC_MAIN);
    assert.ok(s);
    assert.equal(s.assistantTurns, 3);
    assert.equal(s.tokensIn, 16_200 + 18_600 + 42_800);
    assert.equal(s.tokensOut, 300 + 900 + 1_200);
    assert.equal(s.contextTokens, 42_800 + 1_200, 'context = last turn input + output');
    assert.equal(s.compactions, 1);
  });

  it('records context size per turn and where compactions happened', async () => {
    const { session: s } = await claudeCodeAdapter.parse(CC_MAIN);
    assert.deepEqual(s!.contextSeries, [16_500, 19_500, 44_000]);
    assert.deepEqual(s!.compactionPoints, [2], 'the compaction came before the third turn');
  });

  it('records edited files and tool calls', async () => {
    const { session: s } = await claudeCodeAdapter.parse(CC_MAIN);
    assert.ok(s);
    assert.equal(s.toolCalls, 4);
    assert.deepEqual(s.filesTouched.sort(), [
      '/Users/alice/code/acme-shop/src/auth/cookies.ts',
      '/Users/alice/code/acme-shop/src/auth/session.ts',
    ]);
  });

  it('keeps sidechain and thinking content out of the main session', async () => {
    const { session: s } = await claudeCodeAdapter.parse(CC_MAIN);
    const all = s!.messages.map((m) => m.text).join('\n');
    assert.ok(!all.includes('SIDECHAIN'));
    assert.ok(!all.includes('internal reasoning'));
    assert.ok(!all.includes('Caveat:'));
  });

  it('names tool results after the tool that produced them', async () => {
    const { session: s } = await claudeCodeAdapter.parse(CC_MAIN);
    const result = s!.messages.find((m) => m.text.startsWith('Read result'));
    assert.equal(result?.toolName, 'Read');
  });

  it('numbers messages sequentially', async () => {
    const { session: s } = await claudeCodeAdapter.parse(CC_MAIN);
    assert.deepEqual(
      s!.messages.map((m) => m.seq),
      s!.messages.map((_, i) => i),
    );
  });

  it('parses subagent transcripts and links them to the parent', async () => {
    const { session: s } = await claudeCodeAdapter.parse(CC_SUBAGENT);
    assert.ok(s);
    assert.equal(s.isSubagent, true);
    assert.equal(s.parentNativeId, '7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11');
    assert.equal(s.nativeId, '7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11/agent-4e5f6a7b');
    assert.equal(s.model, 'claude-haiku-4-5');
    assert.match(s.title, /Find every caller of getToken/);
  });

  it('returns no session for files without a conversation', async () => {
    const { session, warnings } = await claudeCodeAdapter.parse(CC_SNAPSHOT_ONLY);
    assert.equal(session, null);
    assert.ok(warnings.length > 0);
  });

  it('builds a resume command that resumes the parent for subagents', () => {
    const row = {
      nativeId: '7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11/agent-4e5f6a7b',
      parentId: 'claude-code:7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11',
      isSubagent: true,
      cwd: '/Users/alice/My Projects/shop',
    } as Parameters<typeof claudeCodeAdapter.resumeCommand>[0];
    const cmd = claudeCodeAdapter.resumeCommand(row);
    assert.equal(cmd.command, 'claude');
    assert.deepEqual(cmd.args, ['--resume', '7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11']);
    assert.equal(cmd.display, "cd '/Users/alice/My Projects/shop' && claude --resume 7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11");
  });
});
