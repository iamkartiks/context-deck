import type { ProviderId } from '../schema.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import type { Adapter } from './types.js';

/**
 * The adapter registry. To add a provider, write src/adapters/<name>.ts and add it here.
 * See docs/WRITING_AN_ADAPTER.md.
 */
export const ADAPTERS: Adapter[] = [claudeCodeAdapter, codexAdapter];

export function getAdapter(id: ProviderId): Adapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

export function adapterByPrefix(prefix: string): Adapter | undefined {
  return ADAPTERS.find((a) => a.shortPrefix === prefix || a.id === prefix);
}

export type { Adapter, ResumeCommand } from './types.js';
