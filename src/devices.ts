import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Paired phones, kept in ~/.contextdeck/devices.json (owner-only).
 *
 * A device is a browser on another computer or phone that you allowed to
 * open ContextDeck through Tailscale. Only a SHA-256 of its secret is stored;
 * the secret itself lives in the device's cookie. Each device is tied to the
 * Tailscale login that paired it, so its cookie is useless to anyone else.
 *
 * Pending entries are pairing requests waiting for you to allow or deny them
 * on this computer. They last 5 minutes.
 */

export const SCOPES = ['view', 'decide', 'handoff', 'run', 'edit', 'approve'] as const;
export type Scope = (typeof SCOPES)[number];
export const DEFAULT_SCOPES: Scope[] = ['view', 'decide'];

export interface Device {
  id: string;
  name: string;
  tailscaleLogin: string;
  /** sha256 of the device secret, hex. */
  secretHash: string;
  scopes: Scope[];
  createdAt: string;
  lastSeenAt: string;
  /** lastSeenAt plus the idle limit. */
  expiresAt: string;
}

export interface PendingDevice {
  id: string;
  name: string;
  tailscaleLogin: string;
  /** sha256 of the secret in the phone's short-lived cd_pending cookie, hex. */
  claimHash: string;
  state: 'waiting' | 'approved' | 'denied';
  requestedAt: string;
  expiresAt: string;
}

export interface DeviceFile {
  version: 1;
  devices: Device[];
  pending: PendingDevice[];
}

export const PENDING_MS = 5 * 60_000;
export const DEFAULT_IDLE_DAYS = 30;
export const DEFAULT_MAX_DEVICES = 10;
const MAX_ENTRIES = 50;
const DEVICE_ID_RE = /^dv_[0-9a-f]{10}$/;
const PENDING_ID_RE = /^pd_[0-9a-f]{10}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;

export const devicesPath = (home: string) => join(home, 'devices.json');

export const isDeviceId = (id: string) => DEVICE_ID_RE.test(id);
export const isPendingId = (id: string) => PENDING_ID_RE.test(id);
export const newDeviceId = () => `dv_${randomBytes(5).toString('hex')}`;
export const newPendingId = () => `pd_${randomBytes(5).toString('hex')}`;
/** A new 256-bit secret for a cookie, base64url. */
export const newSecret = () => randomBytes(32).toString('base64url');
export const hashSecret = (secret: string) => createHash('sha256').update(secret, 'utf8').digest('hex');

export function isScope(s: unknown): s is Scope {
  return typeof s === 'string' && (SCOPES as readonly string[]).includes(s);
}

/** A device name as people typed it, made safe to show: no control characters, at most 40 characters. */
export function cleanDeviceName(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim() : '';
  return [...s].slice(0, 40).join('') || 'Phone';
}

/** A Tailscale login as Serve sends it. Kept short and printable. */
export function cleanLogin(login: string): string {
  return login.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 200);
}

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function cleanScopes(v: unknown): Scope[] {
  if (!Array.isArray(v)) return [...DEFAULT_SCOPES];
  return SCOPES.filter((s) => v.includes(s));
}

/** Validate untrusted file contents. Bad entries are dropped, never thrown. */
export function sanitizeDevices(input: unknown): DeviceFile {
  const out: DeviceFile = { version: 1, devices: [], pending: [] };
  const src = input as { devices?: unknown; pending?: unknown } | null;
  const seen = new Set<string>();
  for (const d of Array.isArray(src?.devices) ? src.devices.slice(0, MAX_ENTRIES) : []) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    if (typeof r.id !== 'string' || !DEVICE_ID_RE.test(r.id) || seen.has(r.id)) continue;
    if (typeof r.secretHash !== 'string' || !HASH_RE.test(r.secretHash)) continue;
    if (typeof r.tailscaleLogin !== 'string' || !cleanLogin(r.tailscaleLogin)) continue;
    if (!isTime(r.createdAt) || !isTime(r.lastSeenAt) || !isTime(r.expiresAt)) continue;
    seen.add(r.id);
    out.devices.push({
      id: r.id,
      name: cleanDeviceName(r.name),
      tailscaleLogin: cleanLogin(r.tailscaleLogin),
      secretHash: r.secretHash,
      scopes: cleanScopes(r.scopes),
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
    });
  }
  for (const p of Array.isArray(src?.pending) ? src.pending.slice(0, MAX_ENTRIES) : []) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    if (typeof r.id !== 'string' || !PENDING_ID_RE.test(r.id) || seen.has(r.id)) continue;
    if (typeof r.claimHash !== 'string' || !HASH_RE.test(r.claimHash)) continue;
    if (typeof r.tailscaleLogin !== 'string' || !cleanLogin(r.tailscaleLogin)) continue;
    if (!isTime(r.requestedAt) || !isTime(r.expiresAt)) continue;
    if (r.state !== 'waiting' && r.state !== 'approved' && r.state !== 'denied') continue;
    seen.add(r.id);
    out.pending.push({
      id: r.id,
      name: cleanDeviceName(r.name),
      tailscaleLogin: cleanLogin(r.tailscaleLogin),
      claimHash: r.claimHash,
      state: r.state,
      requestedAt: r.requestedAt,
      expiresAt: r.expiresAt,
    });
  }
  return out;
}

/** Drop expired devices and pending requests. Returns true if anything was dropped. */
export function pruneDevices(file: DeviceFile, now = Date.now()): boolean {
  const before = file.devices.length + file.pending.length;
  file.devices = file.devices.filter((d) => Date.parse(d.expiresAt) > now);
  file.pending = file.pending.filter((p) => Date.parse(p.expiresAt) > now);
  return file.devices.length + file.pending.length !== before;
}

export function loadDevices(home: string): DeviceFile {
  try {
    return sanitizeDevices(JSON.parse(readFileSync(devicesPath(home), 'utf8')));
  } catch {
    return { version: 1, devices: [], pending: [] };
  }
}

/** Write atomically, readable only by you. */
export function saveDevices(home: string, file: DeviceFile): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = devicesPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(sanitizeDevices(file), null, 1), { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not supported everywhere (Windows) */
  }
}

/** Find the entry whose hash matches `secret`, comparing every hash in constant time. */
export function findByHash<T>(entries: T[], secret: string, hashOf: (e: T) => string): T | null {
  const want = Buffer.from(hashSecret(secret), 'hex');
  let found: T | null = null;
  for (const e of entries) {
    const have = Buffer.from(hashOf(e), 'hex');
    if (have.length === want.length && timingSafeEqual(have, want)) found = e;
  }
  return found;
}

export const idleExpiry = (from: number, idleDays: number) => new Date(from + idleDays * DAY_MS).toISOString();

/** A device as shown to people: everything except the secret's hash. */
export function publicDevice(d: Device) {
  return { id: d.id, name: d.name, tailscaleLogin: d.tailscaleLogin, scopes: d.scopes, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, expiresAt: d.expiresAt };
}

export function publicPending(p: PendingDevice) {
  return { id: p.id, name: p.name, tailscaleLogin: p.tailscaleLogin, state: p.state, requestedAt: p.requestedAt, expiresAt: p.expiresAt };
}

/**
 * Remove devices by id, or every device with "all". Returns the ids removed.
 * Used by `contextdeck phone revoke` and the desktop device list.
 */
export function revokeDevices(home: string, which: string): string[] {
  const file = loadDevices(home);
  const gone = file.devices.filter((d) => which === 'all' || d.id === which).map((d) => d.id);
  if (!gone.length) return [];
  file.devices = file.devices.filter((d) => !gone.includes(d.id));
  saveDevices(home, file);
  return gone;
}
