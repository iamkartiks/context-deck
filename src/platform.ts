import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

/**
 * Everything that differs between macOS, Linux and Windows when ContextDeck
 * starts another program: the command text you copy, how a new terminal
 * window is opened, and how a tool is run in the current terminal.
 *
 *   macOS    POSIX shell commands; Terminal.app via AppleScript
 *   Linux    POSIX shell commands; the first terminal app found (see TERMINALS)
 *   Windows  PowerShell commands; Windows Terminal, else a PowerShell window
 *
 * A command is described once, as a Launch: a folder, a program and its
 * arguments. Each platform turns that into text or a process.
 */

export type Flavor = 'posix' | 'powershell';

export interface Launch {
  /** Folder to start in. Callers leave it out (null) when it no longer exists. */
  cwd: string | null;
  command: string;
  args: string[];
  /**
   * POSIX only: a raw shell fragment appended after the arguments, used for
   * `"$(cat brief.md)"`. Never built from untrusted input.
   */
  posixTail?: string;
}

export function flavorFor(platform: NodeJS.Platform): Flavor {
  return platform === 'win32' ? 'powershell' : 'posix';
}

export function posixQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function psQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=\\-]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}

const usableCwd = (cwd: string | null) => (cwd && existsSync(cwd) ? cwd : null);

/** The PowerShell command to run, without changing folder (used by terminal launchers). */
export function psCommand(l: Launch): string {
  return [l.command, ...l.args.map(psQuote)].join(' ');
}

/** The command a person copies and pastes, in their platform's shell. */
export function commandText(l: Launch, platform: NodeJS.Platform): string {
  const cwd = l.cwd;
  if (flavorFor(platform) === 'powershell') {
    return `${cwd ? `Set-Location ${psQuote(cwd)}; ` : ''}${psCommand(l)}`;
  }
  const run = [l.command, ...l.args].map(posixQuote).join(' ') + (l.posixTail ? ` ${l.posixTail}` : '');
  return cwd ? `cd ${posixQuote(cwd)} && ${run}` : run;
}

// ── Opening a new terminal window ──────────────────────────────────────────

/** Linux terminals, in the order we try them, and how each is told to run a command. */
const TERMINALS: { name: string; args: (argv: string[]) => string[] }[] = [
  { name: 'gnome-terminal', args: (a) => ['--', ...a] },
  { name: 'konsole', args: (a) => ['-e', ...a] },
  { name: 'xfce4-terminal', args: (a) => ['-x', ...a] },
  { name: 'kitty', args: (a) => a },
  { name: 'alacritty', args: (a) => ['-e', ...a] },
  { name: 'wezterm', args: (a) => ['start', '--', ...a] },
  { name: 'ghostty', args: (a) => ['-e', ...a] },
  { name: 'foot', args: (a) => a },
  { name: 'tilix', args: (a) => ['-e', ...a] },
  { name: 'x-terminal-emulator', args: (a) => ['-e', ...a] },
  { name: 'xterm', args: (a) => ['-e', ...a] },
];

/** Find an executable on PATH (with PATHEXT on Windows). */
export function which(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
  for (const dir of (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext.toLowerCase());
      const P = join(dir, name + ext);
      for (const candidate of new Set([p, P])) {
        try {
          accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
          return candidate;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

export interface TerminalInfo {
  /** Short description for `contextdeck doctor` and errors, e.g. "gnome-terminal". */
  name: string;
  /** Linux: the program that was found on PATH. */
  path?: string;
}

/**
 * Which terminal "Open in Terminal" would use, or null if none (Linux with no
 * terminal app or no graphical session, e.g. over SSH).
 */
export function findTerminal(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): TerminalInfo | null {
  if (platform === 'darwin') return { name: 'Terminal' };
  if (platform === 'win32') return { name: which('wt', env, platform) ? 'Windows Terminal' : 'PowerShell' };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  const preferred = env.TERMINAL ? basename(env.TERMINAL) : null;
  const order = preferred ? [...TERMINALS.filter((t) => t.name === preferred), ...TERMINALS] : TERMINALS;
  for (const t of order) {
    const path = which(t.name, env, platform);
    if (path) return { name: t.name, path };
  }
  return null;
}

function run(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; verbatim?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: opts.verbatim,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Characters that mean something to cmd.exe, Windows Terminal or PowerShell
 * double quotes. Text containing them is never put on a Windows command line.
 */
const WINDOWS_UNSAFE = /["%^&|<>!`$;\x00-\x1f]/;

export function windowsSafe(s: string): boolean {
  return !WINDOWS_UNSAFE.test(s);
}

/** Open a new terminal window that runs the launch, in its folder. */
export async function openInTerminal(
  l: Launch,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TerminalInfo> {
  const term = findTerminal(platform, env);
  if (!term) {
    throw new Error(
      platform === 'linux'
        ? 'No terminal app found (or no graphical session). Copy the command instead.'
        : 'Opening a terminal is not supported here. Copy the command instead.',
    );
  }

  l = { ...l, cwd: usableCwd(l.cwd) };

  if (platform === 'darwin') {
    const line = commandText(l, platform);
    const escaped = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Terminal"\n  activate\n  do script "${escaped}"\nend tell`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`osascript exited with ${code}`))));
    });
    return term;
  }

  if (platform === 'linux') {
    // Run the command in bash, then leave an interactive shell open in that folder
    const line = commandText(l, platform);
    const argv = ['bash', '-lc', `${line}; exec "\${SHELL:-bash}"`];
    const recipe = TERMINALS.find((t) => t.name === term.name)!;
    await run(term.path ?? term.name, recipe.args(argv), { cwd: l.cwd ?? undefined, env });
    return term;
  }

  // Windows: the command goes through a command line, so only plain characters are allowed
  const ps = psCommand(l);
  const cwd = l.cwd;
  if (!windowsSafe(ps) || (cwd && !windowsSafe(cwd))) {
    throw new Error('This command has characters that can’t be passed to a new window safely. Copy the command instead.');
  }
  if (term.name === 'Windows Terminal') {
    await run('wt.exe', [...(cwd ? ['-d', cwd] : []), 'powershell.exe', '-NoExit', '-Command', ps]);
  } else {
    await run('cmd.exe', ['/d', '/s', '/c', `start "" ${cwd ? `/d "${cwd}" ` : ''}powershell.exe -NoExit -Command "${ps}"`], {
      verbatim: true,
    });
  }
  return term;
}

// ── Running a tool in this terminal (`--run`) ──────────────────────────────

/**
 * Run a tool here, attached to this terminal. On Windows, tools installed with
 * npm are `.cmd` launchers that need a shell, so every argument must be
 * Windows-safe (ids and the one-line handoff prompt are).
 */
export function runHere(l: Launch, platform: NodeJS.Platform = process.platform): Promise<number> {
  const cwd = usableCwd(l.cwd) ?? process.cwd();
  if (platform === 'win32' && !l.args.every(windowsSafe)) {
    return Promise.reject(new Error('These arguments can’t be passed safely on Windows. Copy the command instead.'));
  }
  return new Promise((resolve, reject) => {
    const child =
      platform === 'win32'
        ? spawn([l.command, ...l.args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' '), {
            cwd,
            stdio: 'inherit',
            shell: true,
          })
        : spawn(l.command, l.args, { cwd, stdio: 'inherit' });
    child.on('error', (err) =>
      reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`\`${l.command}\` is not installed or not on your PATH.`) : err),
    );
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

/** Make text safe to put on a Windows command line: special characters and line breaks become spaces. */
export function windowsSafeText(text: string, max = 80): string {
  const cleaned = text
    .replace(/["%^&|<>!`$;\s\x00-\x1f]+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3).trimEnd()}...` : cleaned;
}
