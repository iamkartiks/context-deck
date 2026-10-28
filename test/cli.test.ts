import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { REPO, scratch } from './helpers.js';

const s = scratch();
const BIN = join(REPO, 'bin/contextdeck.js');

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [BIN, '--home', s.home, '--claude-dir', s.claude, '--codex-dir', s.codex, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('cli', () => {
  after(() => s.cleanup());

  it('prints help and version', () => {
    assert.match(run('--help').out, /contextdeck/);
    assert.match(run('--version').out, /^\d+\.\d+\.\d+/);
  });

  it('indexes and reports a JSON summary', () => {
    const r = run('index', '--json');
    assert.equal(r.code, 0, r.err);
    const sum = JSON.parse(r.out);
    assert.equal(sum.indexed, 5);
    assert.equal(r.err, '', 'no experimental-warning noise on stderr');
  });

  it('list --json returns sessions', () => {
    const rows = JSON.parse(run('list', '--json').out);
    assert.equal(rows.length, 4);
    assert.ok(rows[0].shortId);
  });

  it('search finds text across tools', () => {
    const r = run('search', 'cookie');
    assert.equal(r.code, 0);
    assert.match(r.out, /Claude Code/);
    assert.match(r.out, /Codex CLI/);
  });

  it('show includes the resume command', () => {
    const r = run('show', 'cx:d5e6f701');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /codex resume 019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701/);
  });

  it('resume prints the command without running it', () => {
    const r = run('resume', 'cc:0f3a1b11');
    assert.equal(r.out.trim(), 'cd /Users/alice/code/acme-shop && claude --resume 7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11');
  });

  it('related, projects, stats and doctor succeed', () => {
    assert.match(run('related', 'cc:0f3a1b11').out, /1 shared file/);
    assert.match(run('projects').out, /acme-shop/);
    assert.equal(JSON.parse(run('stats', '--json').out).sessions, 4);
    assert.equal(run('doctor').code, 0);
  });

  it('uses exit code 2 for usage errors and 1 for failures', () => {
    assert.equal(run('nonsense').code, 2);
    assert.equal(run('search').code, 2);
    assert.equal(run('list', '--limit', 'abc').code, 2);
    assert.equal(run('--not-a-flag').code, 2);
    const missing = run('show', 'does-not-exist');
    assert.equal(missing.code, 1);
    assert.match(missing.err, /No session matches/);
  });
});
