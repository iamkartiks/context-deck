import type { Scope } from './devices.js';

/**
 * What each API route needs, in one table.
 *
 * Local requests (a browser on this computer) may call every route. Remote
 * requests (a paired device, through Tailscale) may call a route only if the
 * device holds its scope. `local` routes are never allowed remotely, whatever
 * the device holds. `pairing` routes are the only ones an unpaired device may
 * call. A route missing from this table is refused remotely.
 */

/**
 * `runs`: starting a run, where the scope depends on the request body (see
 * runScopes()). A phone needs `handoff` or `run` to reach the route at all.
 */
export type RouteAccess = Scope | 'local' | 'pairing' | 'runs';

export interface RouteRule {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Exact path, or a prefix when it ends with `/*` (the rest is one id). */
  path: string;
  access: RouteAccess;
}

export const ROUTES: readonly RouteRule[] = [
  // Reading
  { method: 'GET', path: '/api/board', access: 'view' },
  { method: 'GET', path: '/api/session/*', access: 'view' },
  { method: 'GET', path: '/api/search', access: 'view' },
  { method: 'GET', path: '/api/matches', access: 'view' },
  { method: 'GET', path: '/api/decisions', access: 'view' },
  { method: 'GET', path: '/api/layout', access: 'view' },
  { method: 'GET', path: '/api/semantic', access: 'view' },
  { method: 'GET', path: '/api/events', access: 'view' },

  // Decisions
  { method: 'POST', path: '/api/decisions', access: 'decide' },
  { method: 'PUT', path: '/api/decisions/*', access: 'decide' },
  { method: 'DELETE', path: '/api/decisions/*', access: 'decide' },

  // Handoff: the preview only builds a brief; starting one opens a terminal here
  { method: 'GET', path: '/api/handoff/preview', access: 'handoff' },
  { method: 'POST', path: '/api/handoff', access: 'local' },

  // Runs: agents started on this computer, watched and stopped from anywhere
  { method: 'GET', path: '/api/runs', access: 'view' },
  { method: 'GET', path: '/api/runs/*', access: 'view' },
  { method: 'POST', path: '/api/runs', access: 'runs' },
  { method: 'DELETE', path: '/api/runs/*', access: 'run' },
  { method: 'GET', path: '/api/approvals', access: 'approve' },
  { method: 'POST', path: '/api/approvals/*', access: 'approve' },

  // Never from another device
  { method: 'POST', path: '/api/open-terminal', access: 'local' },
  { method: 'PUT', path: '/api/layout', access: 'local' },
  { method: 'POST', path: '/api/reindex', access: 'local' },
  { method: 'PUT', path: '/api/semantic', access: 'local' },

  // Pairing, from the phone
  { method: 'POST', path: '/api/pair', access: 'pairing' },
  { method: 'GET', path: '/api/pair/status', access: 'pairing' },

  // Managing devices, on this computer only
  { method: 'POST', path: '/api/pair/code', access: 'local' },
  { method: 'GET', path: '/api/devices', access: 'local' },
  { method: 'POST', path: '/api/devices/pending/*', access: 'local' },
  { method: 'PUT', path: '/api/devices/*', access: 'local' },
  { method: 'DELETE', path: '/api/devices/*', access: 'local' },
];

function matches(rule: RouteRule, path: string): boolean {
  if (!rule.path.endsWith('/*')) return rule.path === path;
  const base = rule.path.slice(0, -1);
  return path.startsWith(base) && path.length > base.length && !path.slice(base.length).includes('/');
}

/** The rule for a request, or null when the route isn't in the table. */
export function routeAccess(method: string, path: string): RouteAccess | null {
  return ROUTES.find((r) => r.method === method && matches(r, path))?.access ?? null;
}

/**
 * The scopes a phone needs to start a run: `handoff` to hand off a session,
 * `run` to resume one or start a new one, plus `edit` for "Edit this folder"
 * or `approve` for "Ask me first".
 */
export function runScopes(kind: string, mode: string): Scope[] {
  const scopes: Scope[] = [kind === 'handoff' ? 'handoff' : 'run'];
  if (mode === 'edit') scopes.push('edit');
  // Ask me first: the agent may do what someone allows, so the phone must be able to answer
  else if (mode !== 'plan') scopes.push('approve');
  return scopes;
}
