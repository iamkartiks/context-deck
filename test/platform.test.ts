import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  commandText,
  findTerminal,
  openInTerminal,
  psQuote,
  runHere,
  windowsSafe,
  windowsSafeText,
  which,
  type Launch,
} from '../src/platform.js';
import { scratch } from './helpers.js';

const resume: Launch = { cwd: "/Users/a/it's here", command: 'codex', args: ['resume', 'abc-123'] };

describe('command text', () => {
  it('quotes anything a POSIX shell could interpret', () => {
    assert.equal(commandText(resume, 'darwin'), `cd '/Users/a/it'\\''s here' && codex resume abc-123`);
    assert.equal(commandText({ cwd: null, command: 'claude', args: ['--resume', '$(rm -rf ~)'] }, 'linux'), `claude --resume '$(rm -rf ~)'`);
  });

  it('writes PowerShell on Windows', () => {
    assert.equal(commandText(resume, 'win32'), `Set-Location '/Users/a/it''s here'; codex resume abc-123`);
    assert.equal(
      commandText({ cwd: 'C:\\Users\\alice\\code\\shop', command: 'claude', args: ['--resume', 'x y'] }, 'win32'),
      `Set-Location C:\\Users\\alice\\code\\shop; claude --resume 'x y'`,
    );
    assert.equal(psQuote('$(evil)'), `'$(evil)'`, 'single quotes: nothing inside is expanded');
  });

  it('appends the brief reader only on POSIX', () => {
    const l: Launch = { cwd: null, command: 'codex', args: [], posixTail: `"$(cat /tmp/b.md)"` };
    assert.equal(commandText(l, 'linux'), `codex "$(cat /tmp/b.md)"`);
  });
});

describe('Windows-safe text', () => {
  it('strips characters cmd.exe or PowerShell would act on', () => {
    assert.equal(windowsSafeText('Fix "a" & b | c > d; %PATH% ^x !y `z` $w\nnext'), 'Fix a b c d PATH x y z w next');
    assert.equal(windowsSafeText('x'.repeat(200)).length, 80);
    assert.equal(windowsSafe('C:\\Users\\José\\code (old)'), true, 'accents and brackets are fine');
    assert.equal(windowsSafe('C:\\a&b'), false);
  });

  it('refuses to run unsafe arguments through the Windows shell', async () => {
    await assert.rejects(runHere({ cwd: null, command: 'codex', args: ['a & calc'] }, 'win32'), /can’t be passed safely/);
  });

  it('refuses to open a window for an unsafe command', async () => {
    await assert.rejects(
      openInTerminal({ cwd: null, command: 'codex', args: ['50%'] }, 'win32', { PATH: '' }),
      /can’t be passed to a new window safely/,
    );
  });
});

describe('finding a terminal', () => {
  it('needs a graphical session on Linux', () => {
    assert.equal(findTerminal('linux', { PATH: '/usr/bin:/bin' }), null);
  });

  it('knows the macOS and Windows defaults', () => {
    assert.deepEqual(findTerminal('darwin', {}), { name: 'Terminal' });
    assert.deepEqual(findTerminal('win32', { PATH: '' }), { name: 'PowerShell' });
  });

  it(
    'prefers $TERMINAL, then the usual order',
    { skip: process.platform === 'win32' && 'POSIX executables' },
    () => {
      const s = scratch();
      try {
        const bin = join(s.dir, 'bin');
        mkdirSync(bin, { recursive: true });
        for (const name of ['xterm', 'konsole']) {
          writeFileSync(join(bin, name), '#!/bin/sh\n');
          chmodSync(join(bin, name), 0o755);
        }
        writeFileSync(join(bin, 'gnome-terminal'), 'not executable');
        const env = { PATH: bin, DISPLAY: ':0' };
        assert.equal(which('xterm', env, 'linux'), join(bin, 'xterm'));
        assert.equal(which('gnome-terminal', env, 'linux'), null, 'must be executable');
        assert.deepEqual(findTerminal('linux', env), { name: 'konsole', path: join(bin, 'konsole') });
        assert.equal(findTerminal('linux', { ...env, TERMINAL: '/usr/bin/xterm' })?.name, 'xterm');
        assert.equal(findTerminal('linux', { ...env, WAYLAND_DISPLAY: 'wayland-0', DISPLAY: undefined })?.name, 'konsole');
      } finally {
        s.cleanup();
      }
    },
  );
});

describe('opening a terminal on Linux', { skip: process.platform === 'win32' && 'POSIX executables' }, () => {
  it('runs the command in its folder, as one argument, then keeps a shell open', async () => {
    const s = scratch();
    try {
      const bin = join(s.dir, 'bin');
      mkdirSync(bin, { recursive: true });
      const record = join(s.dir, 'terminal.json');
      // A fake gnome-terminal that records how it was called
      writeFileSync(
        join(bin, 'gnome-terminal'),
        `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`,
      );
      chmodSync(join(bin, 'gnome-terminal'), 0o755);
      const project = join(s.dir, "it's a project");
      mkdirSync(project, { recursive: true });

      const term = await openInTerminal(
        { cwd: project, command: 'codex', args: ['resume', '$(touch pwned)'] },
        'linux',
        { PATH: `${bin}:${process.env.PATH}`, DISPLAY: ':0' },
      );
      assert.equal(term.name, 'gnome-terminal');
      for (let i = 0; i < 100 && !existsSync(record); i++) await new Promise((r) => setTimeout(r, 20));
      const got = JSON.parse(readFileSync(record, 'utf8'));
      assert.equal(realpathSync(got.cwd), realpathSync(project));
      assert.deepEqual(got.argv.slice(0, 3), ['--', 'bash', '-lc']);
      assert.match(got.argv[3], /; exec "\$\{SHELL:-bash\}"$/);

      // Run what the terminal would run (without the trailing interactive shell)
      // against a fake `codex`, and check the arguments arrive intact.
      const codexRecord = join(s.dir, 'codex.json');
      writeFileSync(
        join(bin, 'codex'),
        `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(codexRecord)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n`,
      );
      chmodSync(join(bin, 'codex'), 0o755);
      const line = (got.argv[3] as string).replace(/; exec "\$\{SHELL:-bash\}"$/, '');
      const r = spawnSync('bash', ['-c', line], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const ran = JSON.parse(readFileSync(codexRecord, 'utf8'));
      assert.deepEqual(ran.args, ['resume', '$(touch pwned)']);
      assert.equal(realpathSync(ran.cwd), realpathSync(project));
      assert.equal(existsSync(join(project, 'pwned')), false);
    } finally {
      s.cleanup();
    }
  });

  it('drops a project folder that no longer exists', async () => {
    const s = scratch();
    try {
      const bin = join(s.dir, 'bin');
      mkdirSync(bin, { recursive: true });
      const record = join(s.dir, 'xterm.json');
      writeFileSync(join(bin, 'xterm'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`);
      chmodSync(join(bin, 'xterm'), 0o755);
      await openInTerminal({ cwd: '/definitely/not/here', command: 'claude', args: ['--resume', 'x'] }, 'linux', {
        PATH: `${bin}:${process.env.PATH}`,
        DISPLAY: ':0',
      });
      for (let i = 0; i < 100 && !existsSync(record); i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), ['-e', 'bash', '-lc', 'claude --resume x; exec "${SHELL:-bash}"']);
    } finally {
      s.cleanup();
    }
  });
});

describe('running a tool here', { skip: process.platform === 'win32' && 'POSIX executables' }, () => {
  it('passes arguments without a shell and returns the exit code', async () => {
    const code = await runHere({ cwd: null, command: process.execPath, args: ['-e', 'process.exit(process.argv[1] === "$(x) \'y\'" ? 7 : 1)', "$(x) 'y'"] }, 'linux');
    assert.equal(code, 7);
  });

  it('says when the tool is not installed', async () => {
    await assert.rejects(runHere({ cwd: null, command: 'definitely-not-a-tool-xyz', args: [] }, 'linux'), /not installed or not on your PATH/);
  });
});
