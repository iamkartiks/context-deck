import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Settings you choose, kept in ~/.contextdeck/config.json (owner-only).
 *
 * Today this is only search by meaning, which is off until you turn it on.
 */

export type EmbeddingApi = 'ollama' | 'openai';

export interface SemanticSettings {
  enabled: boolean;
  /** "ollama" (POST /api/embed) or "openai" (POST /v1/embeddings: LM Studio, llama.cpp, vLLM, …). */
  api: EmbeddingApi;
  /** Where the model server listens. Must be on this computer unless allowRemote is set. */
  url: string;
  model: string;
  /** Keep the first N numbers of each vector (smaller index). 0 keeps them all. */
  dims: number;
  /** Allow a server that isn't on this computer. Session text is then sent to it. */
  allowRemote: boolean;
}

export interface Settings {
  version: 1;
  semantic: SemanticSettings;
}

export const DEFAULT_MODEL = 'qwen3-embedding:0.6b';
export const DEFAULT_URLS: Record<EmbeddingApi, string> = {
  ollama: 'http://127.0.0.1:11434',
  openai: 'http://127.0.0.1:1234',
};

export function defaultSettings(): Settings {
  return {
    version: 1,
    semantic: { enabled: false, api: 'ollama', url: DEFAULT_URLS.ollama, model: DEFAULT_MODEL, dims: 512, allowRemote: false },
  };
}

export const settingsPath = (home: string) => join(home, 'config.json');

/** Validate untrusted settings. Anything invalid falls back to the default. */
export function sanitizeSettings(input: unknown): Settings {
  const out = defaultSettings();
  const s = (input as { semantic?: Record<string, unknown> } | null)?.semantic;
  if (!s || typeof s !== 'object') return out;
  const sem = out.semantic;
  if (typeof s.enabled === 'boolean') sem.enabled = s.enabled;
  if (s.api === 'ollama' || s.api === 'openai') {
    sem.api = s.api;
    sem.url = DEFAULT_URLS[s.api];
  }
  if (typeof s.url === 'string' && isHttpUrl(s.url)) sem.url = s.url.replace(/\/+$/, '');
  if (typeof s.model === 'string' && /^[\w.:/@+-]{1,200}$/.test(s.model)) sem.model = s.model;
  if (typeof s.dims === 'number' && Number.isInteger(s.dims) && s.dims >= 0 && s.dims <= 8192) sem.dims = s.dims;
  if (typeof s.allowRemote === 'boolean') sem.allowRemote = s.allowRemote;
  return out;
}

export function loadSettings(home: string): Settings {
  try {
    return sanitizeSettings(JSON.parse(readFileSync(settingsPath(home), 'utf8')));
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(home: string, settings: Settings): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = settingsPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(sanitizeSettings(settings), null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not supported everywhere */
  }
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** True when the URL points at this computer. */
export function isLocalUrl(s: string): boolean {
  try {
    const host = new URL(s).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}
