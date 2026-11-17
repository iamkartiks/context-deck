import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS, getAdapter } from '../src/adapters/index.js';
import { claudeCodeHeadless, codexHeadless, parseClaudeStyleLine, parseCodexLine, qwenCodeHeadless, summarizeInput } from '../src/adapters/headless.js';
import { RUN_MODES, type HeadlessDriver, type RunEvent } from '../src/adapters/types.js';
import type { SessionRow } from '../src/schema.js';
import { FIXTURES, scratch, writeFakeAgent } from './helpers.js';

const CWD = '/Users/alice/code/acme-shop';
const session = (over: Partial<SessionRow> = {}) => ({ nativeId: '7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11', cwd: CWD, ...over }) as SessionRow;
const streams = (name: string) => join(FIXTURES, 'streams', `${name}.jsonl`);
const replay = (name: string, parse: (l: string) => RunEvent[]) => readFileSync(streams(name), 'utf8').split('\n').flatMap(parse);

const DRIVERS: [string, HeadlessDriver][] = [
  ['claude-code', claudeCodeHeadless],
  ['codex', codexHeadless],
  ['qwen-code', qwenCodeHeadless],
];

describe('headless drivers: arguments', () => {
  it('every built-in adapter has one', () => {
    for (const a of ADAPTERS) assert.ok(a.headless, a.id);
    assert.equal(getAdapter('claude-code')!.headless, claudeCodeHeadless);
  });

  it('builds exactly these commands (Claude Code)', () => {
    const id = session().nativeId;
    const stream = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    assert.deepEqual(claudeCodeHeadless.continueArgs(session(), 'plan'), {
      command: 'claude',
      args: ['-p', '--resume', id, ...stream, '--permission-mode', 'plan', '--permission-prompts', 'none'],
      cwd: CWD,
    });
    assert.deepEqual(claudeCodeHeadless.continueArgs(session(), 'edit').args.slice(-4), ['--permission-mode', 'acceptEdits', '--permission-prompts', 'none']);
    assert.deepEqual(claudeCodeHeadless.startArgs('/tmp/x', 'plan'), {
      command: 'claude',
      args: ['-p', ...stream, '--permission-mode', 'plan', '--permission-prompts', 'none'],
      cwd: '/tmp/x',
    });
  });

  it('builds an “ask me first” command for Claude Code: manual mode, every request to the approver', () => {
    assert.deepEqual(claudeCodeHeadless.continueArgs(session(), 'ask', { mcpConfig: '/tmp/x/mcp.json', tool: 'mcp__contextdeck__approve' }).args.slice(-6), [
      '--permission-mode',
      'manual',
      '--mcp-config',
      '/tmp/x/mcp.json',
      '--permission-prompt-tool',
      'mcp__contextdeck__approve',
    ]);
    assert.equal(claudeCodeHeadless.supportsAsk, true);
    assert.equal(codexHeadless.supportsAsk, false);
    assert.equal(qwenCodeHeadless.supportsAsk, false);
  });

  it('builds exactly these commands (Codex), with the sandbox in config too', () => {
    const id = '019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701';
    assert.deepEqual(codexHeadless.continueArgs(session({ nativeId: id }), 'plan'), {
      command: 'codex',
      args: ['exec', 'resume', '--json', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', id, '-'],
      cwd: CWD,
    });
    assert.ok(codexHeadless.continueArgs(session({ nativeId: id }), 'edit').args.includes('sandbox_mode="workspace-write"'));
    assert.deepEqual(codexHeadless.startArgs('/tmp/x', 'edit'), {
      command: 'codex',
      args: ['exec', '--json', '--sandbox', 'workspace-write', '-C', '/tmp/x', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', '-'],
      cwd: '/tmp/x',
    });
  });

  it('builds exactly these commands (Qwen Code)', () => {
    const id = '5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61';
    assert.deepEqual(qwenCodeHeadless.continueArgs(session({ nativeId: id }), 'plan'), {
      command: 'qwen',
      args: ['--resume', id, '--output-format', 'stream-json', '--include-partial-messages', '--approval-mode', 'plan'],
      cwd: CWD,
    });
    assert.deepEqual(qwenCodeHeadless.startArgs('/tmp/x', 'edit').args, ['--output-format', 'stream-json', '--include-partial-messages', '--approval-mode', 'auto-edit']);
  });

  it('never builds a mode that skips permissions, for any tool, mode or kind of run', () => {
    const FORBIDDEN = [
      /bypassPermissions/i,
      /dontAsk/i,
      /danger-full-access/,
      /\byolo\b/,
      /--dangerously/,
      /--allow-dangerously/,
      /--approve-for-me/,
      /--bare/,
      /--skip-git-repo-check/,
      /--add-dir/,
      /^--permission-mode=/,
      /^--approval-mode=/,
    ];
    const ALLOWED_VALUE: Record<string, string[]> = {
      '--permission-mode': ['plan', 'acceptEdits', 'manual'],
      '--approval-mode': ['plan', 'auto-edit'],
      '--sandbox': ['read-only', 'workspace-write'],
      '--permission-prompts': ['none'],
      '--permission-prompt-tool': ['mcp__contextdeck__approve'],
      '--mcp-config': ['/tmp/cd-run-x/mcp.json'],
    };
    const approver = { mcpConfig: '/tmp/cd-run-x/mcp.json', tool: 'mcp__contextdeck__approve' };
    for (const [name, d] of DRIVERS) {
      for (const mode of RUN_MODES) {
        if (mode === 'ask' && !d.supportsAsk) {
          assert.throws(() => d.continueArgs(session(), mode), /can’t ask for approval here/, name);
          assert.throws(() => d.startArgs(CWD, mode), /can’t ask for approval here/, name);
          continue;
        }
        for (const cmd of [d.continueArgs(session(), mode, approver), d.startArgs(CWD, mode, approver)]) {
          const where = `${name} ${mode}: ${cmd.args.join(' ')}`;
          for (const a of cmd.args) for (const re of FORBIDDEN) assert.doesNotMatch(a, re, where);
          cmd.args.forEach((a, i) => {
            if (ALLOWED_VALUE[a]) assert.ok(ALLOWED_VALUE[a]!.includes(cmd.args[i + 1]!), `${where}: ${a} ${cmd.args[i + 1]}`);
            if (a === '-c') assert.match(cmd.args[i + 1]!, /^(sandbox_mode="(read-only|workspace-write)"|approval_policy="never")$/, where);
          });
          // Plan only never allows writes
          if (mode === 'plan') assert.doesNotMatch(cmd.args.join(' '), /acceptEdits|auto-edit|workspace-write|manual/, where);
          // Ask me first: every request goes to the approver, and nothing turns prompts off
          if (mode === 'ask') {
            assert.ok(cmd.args.includes('--permission-prompt-tool'), where);
            assert.ok(!cmd.args.includes('--permission-prompts'), where);
          } else {
            assert.ok(!cmd.args.includes('--permission-prompt-tool') && !cmd.args.includes('--mcp-config'), where);
          }
        }
      }
      if (d.supportsAsk) assert.throws(() => d.startArgs(CWD, 'ask'), /needs ContextDeck’s approver/, name);
    }
  });

  it('refuses session ids that could be read as flags, and sessions with no folder', () => {
    for (const [, d] of DRIVERS) {
      for (const bad of ['--dangerously-skip-permissions', '-p', '', 'a b', 'x;rm -rf ~', 'a'.repeat(200)]) {
        assert.throws(() => d.continueArgs(session({ nativeId: bad }), 'plan'), /safely/, bad);
      }
      assert.throws(() => d.continueArgs(session({ cwd: null }), 'plan'), /project folder/);
    }
  });

  it('uses the binary from CONTEXTDECK_*_BIN when set', () => {
    process.env.CONTEXTDECK_CODEX_BIN = '/opt/fake/codex';
    try {
      assert.equal(codexHeadless.startArgs(CWD, 'plan').command, '/opt/fake/codex');
    } finally {
      delete process.env.CONTEXTDECK_CODEX_BIN;
    }
    assert.equal(codexHeadless.startArgs(CWD, 'plan').command, 'codex');
  });

  it('says which version each was checked against', () => {
    for (const [name, d] of DRIVERS) assert.match(d.testedWith, /\d+\.\d+/, name);
  });
});

describe('headless drivers: reading output', () => {
  it('reads a Claude Code stream: session, text, tools, a refused command, the result', () => {
    const events = replay('claude-code', parseClaudeStyleLine);
    assert.deepEqual(events[0], { type: 'session', nativeId: '7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11' });
    const text = events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? (e.start ? '¶' : '') + e.delta : '')).join('');
    assert.equal(text, '¶Let me look at the rate limiter.¶The limiter resets every minute. Running the tests needs edit mode.', 'text once, from the deltas');
    assert.deepEqual(
      events.filter((e) => e.type === 'tool'),
      [
        { type: 'tool', name: 'Read', summary: '/Users/alice/code/acme-shop/src/limit.ts' },
        { type: 'tool', name: 'Bash', summary: 'npm test -- limit' },
      ],
    );
    assert.deepEqual(events.filter((e) => e.type === 'denied'), [{ type: 'denied', tool: 'Bash', reason: 'Not allowed in this mode: npm test -- limit' }]);
    assert.deepEqual(events.at(-1), { type: 'done', ok: true, summary: 'The limiter resets every minute. Running the tests needs edit mode.', costUsd: 0.0123 });
  });

  it('reads a Codex stream', () => {
    const events = replay('codex', parseCodexLine);
    assert.deepEqual(events, [
      { type: 'session', nativeId: '019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701' },
      { type: 'tool', name: 'shell', summary: "bash -lc 'rg -n WINDOW_MS src'" },
      { type: 'tool', name: 'shell', summary: "bash -lc 'touch src/new.ts'" },
      { type: 'denied', tool: 'shell', reason: "Not allowed in this mode: bash -lc 'touch src/new.ts'" },
      { type: 'tool', name: 'edit', summary: '/Users/alice/code/acme-shop/src/limit.ts' },
      { type: 'text', delta: 'The limiter resets every minute.', start: true },
      { type: 'done', ok: true },
    ]);
    assert.deepEqual(parseCodexLine('{"type":"turn.failed","error":{"message":"stream disconnected"}}'), [{ type: 'done', ok: false, summary: 'stream disconnected' }]);
    assert.deepEqual(parseCodexLine('{"type":"error","message":"Reconnecting… 1/5"}'), [{ type: 'error', message: 'Reconnecting… 1/5' }]);
  });

  it('reads a Qwen Code stream, including a failed run', () => {
    const events = replay('qwen-code', parseClaudeStyleLine);
    assert.deepEqual(events[0], { type: 'session', nativeId: '5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61' });
    assert.ok(events.some((e) => e.type === 'tool' && e.name === 'read_file' && e.summary.endsWith('src/limit.ts')));
    assert.deepEqual(events.at(-1), { type: 'done', ok: false, summary: 'error during execution' });
  });

  it('never throws, whatever the line', () => {
    const lines = [
      '',
      'plain text',
      '{',
      '[]',
      'null',
      '{"type":42}',
      '{"type":"result","permission_denials":"nope","total_cost_usd":"lots"}',
      '{"type":"assistant","message":{"content":"not a list"}}',
      '{"type":"stream_event","event":null}',
      '{"type":"item.completed","item":{"type":"file_change","changes":[null,1,{"path":7}]}}',
      '{"type":"item.started","item":"x"}',
      `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"${'x'.repeat(2_000_000)}"}}}`,
    ];
    for (const parse of [parseClaudeStyleLine, parseCodexLine]) {
      for (const l of lines) assert.doesNotThrow(() => parse(l), l.slice(0, 60));
    }
    assert.deepEqual(parseClaudeStyleLine('{"type":"result","permission_denials":"nope","total_cost_usd":"lots"}'), [{ type: 'done', ok: true }]);
  });

  it('summarises tool input as one short line', () => {
    assert.equal(summarizeInput({ command: 'npm\n  test' }), 'npm test');
    assert.equal(summarizeInput({ cmd: ['git', 'status'] }), 'git status');
    assert.equal(summarizeInput({ other: 1 }), '');
    assert.equal(summarizeInput({ command: 'x'.repeat(500) }).length, 200);
  });
});

describe('headless drivers: with a fake agent', () => {
  for (const [name, d] of DRIVERS) {
    it(`${name}: the prompt arrives on stdin, never in the arguments, and the output parses`, async () => {
      const s = scratch();
      try {
        const fake = writeFakeAgent(s.dir, { stream: streams(name), name });
        const cmd = d.continueArgs(session({ cwd: s.dir }), 'plan');
        const prompt = 'Check the limiter. SECRET-PROMPT-MARKER\nLine two with "quotes" and $(not a command)';
        const child = spawn(process.execPath, [fake.script, ...cmd.args], { cwd: cmd.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
        child.stdin.end(prompt);
        const code = await new Promise((done) => child.on('close', done));
        assert.equal(code, 0);
        const [call] = fake.calls();
        assert.equal(call!.stdin, prompt);
        assert.deepEqual(call!.args, cmd.args);
        assert.ok(!call!.args.some((a) => a.includes('SECRET-PROMPT-MARKER')));
        const events = out.split('\n').flatMap(d.parseLine);
        assert.equal(events[0]!.type, 'session');
        assert.equal(events.at(-1)!.type, 'done');
      } finally {
        s.cleanup();
      }
    });
  }
});
