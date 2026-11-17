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
  /** Lowest score a match by meaning needs (0–1). null uses the model's default. */
  minScore: number | null;
}

/** Phone mode limits. Phone mode itself is only on while `contextdeck ui --phone` runs. */
export interface PhoneSettings {
  /** A paired device is forgotten after this many days unseen. */
  deviceIdleDays: number;
  /** At most this many paired devices (pending requests count too). */
  maxDevices: number;
  /** A run started from a phone is stopped after this many minutes. */
  runTimeoutMinutes: number;
  /** At most this many runs at once; more wait their turn. */
  maxConcurrentRuns: number;
  /** A permission request nobody answers is denied after this many minutes. */
  approvalTimeoutMinutes: number;
}

export interface Settings {
  version: 1;
  semantic: SemanticSettings;
  phone: PhoneSettings;
}

export const DEFAULT_MODEL = 'qwen3-embedding:0.6b';
export const DEFAULT_URLS: Record<EmbeddingApi, string> = {
  ollama: 'http://127.0.0.1:11434',
  openai: 'http://127.0.0.1:1234',
};

export function defaultSettings(): Settings {
  return {
    version: 1,
    semantic: { enabled: false, api: 'ollama', url: DEFAULT_URLS.ollama, model: DEFAULT_MODEL, dims: 512, allowRemote: false, minScore: null },
    phone: { deviceIdleDays: 30, maxDevices: 10, runTimeoutMinutes: 30, maxConcurrentRuns: 3, approvalTimeoutMinutes: 10 },
  };
}

export const settingsPath = (home: string) => join(home, 'config.json');

/** Validate untrusted settings. Anything invalid falls back to the default. */
export function sanitizeSettings(input: unknown): Settings {
  const out = defaultSettings();
  const p = (input as { phone?: Record<string, unknown> } | null)?.phone;
  if (p && typeof p === 'object') {
    const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
    if (int(p.deviceIdleDays, 1, 365)) out.phone.deviceIdleDays = p.deviceIdleDays as number;
    if (int(p.maxDevices, 1, 50)) out.phone.maxDevices = p.maxDevices as number;
    if (int(p.runTimeoutMinutes, 1, 240)) out.phone.runTimeoutMinutes = p.runTimeoutMinutes as number;
    if (int(p.maxConcurrentRuns, 1, 10)) out.phone.maxConcurrentRuns = p.maxConcurrentRuns as number;
    if (int(p.approvalTimeoutMinutes, 1, 60)) out.phone.approvalTimeoutMinutes = p.approvalTimeoutMinutes as number;
  }
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
  if (typeof s.minScore === 'number' && Number.isFinite(s.minScore) && s.minScore >= 0 && s.minScore <= 1) sem.minScore = s.minScore;
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
