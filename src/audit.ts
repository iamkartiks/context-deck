import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ~/.contextdeck/phone-audit.log: one JSON line per remote action (pairing,
 * approvals, revocations, every write a phone makes). Owner-only. It never
 * holds message text, briefs or secrets: only ids, routes and outcomes.
 * Rotated at 1 MB, keeping one old file (phone-audit.log.1).
 */

export const AUDIT_MAX_BYTES = 1024 * 1024;

export const auditPath = (home: string) => join(home, 'phone-audit.log');

export interface AuditEntry {
  action:
    | 'pair-requested'
    | 'pair-refused'
    | 'pair-approved'
    | 'pair-denied'
    | 'pair-claimed'
    | 'device-revoked'
    | 'device-scopes'
    | 'run-started'
    | 'run-ended'
    | 'approval-asked'
    | 'approval-answered'
    | 'write';
  deviceId?: string;
  pendingId?: string;
  login?: string;
  method?: string;
  route?: string;
  status?: number;
  scopes?: string[];
  reason?: string;
  runId?: string;
  kind?: string;
  provider?: string;
  mode?: string;
  state?: string;
}

export function appendAudit(home: string, entry: AuditEntry, maxBytes = AUDIT_MAX_BYTES): void {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const path = auditPath(home);
    try {
      if (statSync(path).size >= maxBytes) renameSync(path, `${path}.1`);
    } catch {
      /* no log yet */
    }
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* not supported everywhere (Windows) */
    }
  } catch {
    /* auditing must never break a request */
  }
}
