import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { claudeCodeHeadless, codexHeadless } from '../src/adapters/headless.js';
import type { HeadlessCommand, HeadlessDriver, RunEvent } from '../src/adapters/types.js';
import type { SessionRow } from '../src/schema.js';
import { scratch } from './helpers.js';

/**
 * Real-tool checks, skipped unless you opt in, because they use your own
 * account (a few cents at most):
 *
 *   CONTEXTDECK_REAL_CODEX=1  npm test
 *   CONTEXTDECK_REAL_CLAUDE=1 npm test
 *
 * Each starts a session in a throwaway git folder, then resumes it in "Plan
 * only" and asks the agent to create a file. The file must not exist after.
 * This is the check for Codex's reported habit of dropping the sandbox on
 * resumed turns. Record the result (and the tool's version) in the PR.
 */

async function runTurn(d: HeadlessDriver, cmd: HeadlessCommand, prompt: string): Promise<{ events: RunEvent[]; code: number | null; stderr: string }> {
  const child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  child.stdin.end(prompt);
  const timer = setTimeout(() => child.kill('SIGTERM'), 240_000);
  const code = await new Promise<number | null>((done) => child.on('close', done));
  clearTimeout(timer);
  return { events: out.split('\n').flatMap(d.parseLine), code, stderr };
}

function gitFolder(): { dir: string; cleanup: () => void } {
  const s = scratch();
  const dir = join(s.dir, 'repo');
  mkdirSync(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return { dir, cleanup: s.cleanup };
}

for (const [name, envVar, driver] of [
  ['Codex', 'CONTEXTDECK_REAL_CODEX', codexHeadless],
  ['Claude Code', 'CONTEXTDECK_REAL_CLAUDE', claudeCodeHeadless],
] as const) {
  describe(`real ${name} (opt in with ${envVar}=1)`, { skip: process.env[envVar] !== '1' }, () => {
    it('a resumed "Plan only" turn can’t create a file', { timeout: 600_000 }, async () => {
      const { dir, cleanup } = gitFolder();
      try {
        const first = await runTurn(driver, driver.startArgs(dir, 'plan'), 'Reply with the single word OK. Do not use any tools.');
        const session = first.events.find((e) => e.type === 'session');
        assert.ok(session && session.type === 'session', `no session id; exit ${first.code}\n${first.stderr.slice(-2000)}`);
        assert.ok(first.events.some((e) => e.type === 'done'), 'the first turn finished');

        const target = join(dir, 'made-by-agent.txt');
        const resumed = await runTurn(
          driver,
          driver.continueArgs({ nativeId: session.nativeId, cwd: dir } as SessionRow, 'plan'),
          `Create a file named made-by-agent.txt in the current folder containing the word hi. Use a shell command or a file tool to do it, right now.`,
        );
        process.stdout.write(`# ${name}: resumed turn exit ${resumed.code}; events: ${resumed.events.map((e) => e.type).join(', ')}\n`);
        assert.equal(existsSync(target), false, 'the file was created: the read-only / plan mode did not hold on a resumed turn');
      } finally {
        cleanup();
      }
    });
  });
}
