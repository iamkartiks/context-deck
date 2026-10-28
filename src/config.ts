import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ADAPTERS } from './adapters/index.js';
import type { Source } from './indexer.js';

export interface Config {
  home: string;
  dbPath: string;
  sources: Source[];
}

export interface ConfigOverrides {
  home?: string;
  claudeDir?: string;
  codexDir?: string;
  providers?: string[];
}

/**
 * Where things live. Precedence: CLI flag > environment variable > default.
 *
 *   CONTEXTDECK_HOME        index location           (default ~/.contextdeck)
 *   CONTEXTDECK_CLAUDE_DIR  Claude Code config dir   (default $CLAUDE_CONFIG_DIR or ~/.claude)
 *   CONTEXTDECK_CODEX_DIR   Codex home               (default $CODEX_HOME or ~/.codex)
 */
export function loadConfig(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): Config {
  const userHome = homedir();
  const home = resolve(overrides.home ?? env.CONTEXTDECK_HOME ?? join(userHome, '.contextdeck'));
  const flagRoots: Record<string, string | undefined> = {
    'claude-code': overrides.claudeDir,
    codex: overrides.codexDir,
  };
  const wanted = overrides.providers?.length ? new Set(overrides.providers) : null;
  const sources = ADAPTERS.filter((a) => !wanted || wanted.has(a.id) || wanted.has(a.shortPrefix)).map((adapter) => ({
    adapter,
    root: resolve(flagRoots[adapter.id] ?? adapter.defaultRoot(env, userHome)),
  }));
  return { home, dbPath: join(home, 'index.db'), sources };
}
