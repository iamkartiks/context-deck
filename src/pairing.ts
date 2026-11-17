import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * One-time pairing codes, held in memory only.
 *
 * A code is 128 random bits, valid for 5 minutes and usable once. Only the
 * newest code is valid: making a new one cancels the last. Attempts are
 * rate limited per Tailscale login and in total, so a code can't be guessed.
 */

export const CODE_MS = 5 * 60_000;
export const ATTEMPTS_PER_MINUTE = 5;

export type CodeCheck = 'ok' | 'wrong' | 'expired' | 'used' | 'too-many';

export class PairingCodes {
  private current: { code: string; expiresAt: number; used: boolean } | null = null;
  private attempts: { login: string; at: number }[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly perMinute = ATTEMPTS_PER_MINUTE,
  ) {}

  /** A new code; any earlier one stops working. */
  create(): { code: string; expiresAt: string } {
    const code = randomBytes(16).toString('base64url');
    this.current = { code, expiresAt: this.now() + CODE_MS, used: false };
    return { code, expiresAt: new Date(this.current.expiresAt).toISOString() };
  }

  /** Cancel the current code, if any. */
  clear(): void {
    this.current = null;
  }

  /** Check a code and use it up if it is right. Every call counts as an attempt. */
  consume(code: unknown, login: string): CodeCheck {
    const now = this.now();
    this.attempts = this.attempts.filter((a) => now - a.at < 60_000);
    const mine = this.attempts.filter((a) => a.login === login).length;
    if (mine >= this.perMinute || this.attempts.length >= this.perMinute) return 'too-many';
    this.attempts.push({ login, at: now });
    const cur = this.current;
    if (!cur || typeof code !== 'string') return 'wrong';
    const a = Buffer.from(code);
    const b = Buffer.from(cur.code);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 'wrong';
    if (cur.used) return 'used';
    if (now >= cur.expiresAt) return 'expired';
    cur.used = true;
    return 'ok';
  }
}
