import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from dist/test/ at runtime. */
export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURES = join(REPO, 'fixtures');
export const CLAUDE_FIXTURES = join(FIXTURES, 'claude');
export const CODEX_FIXTURES = join(FIXTURES, 'codex');
export const QWEN_FIXTURES = join(FIXTURES, 'qwen');

export const CC_MAIN = join(
  CLAUDE_FIXTURES,
  'projects/-Users-alice-code-acme-shop/7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11.jsonl',
);
export const CC_SUBAGENT = join(
  CLAUDE_FIXTURES,
  'projects/-Users-alice-code-acme-shop/7c1e2a90-4b3d-4f6a-9c21-5d8e0f3a1b11/subagents/agent-4e5f6a7b.jsonl',
);
export const CC_SNAPSHOT_ONLY = join(
  CLAUDE_FIXTURES,
  'projects/-Users-alice-code-blog/9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c33.jsonl',
);
export const CX_MODERN = join(
  CODEX_FIXTURES,
  'sessions/2026/10/27/rollout-2026-10-27T08-30-00-019a2f3c-5d6e-7f80-91a2-b3c4d5e6f701.jsonl',
);
export const CX_LEGACY = join(
  CODEX_FIXTURES,
  'sessions/2025/08/14/rollout-2025-08-14T16-05-11-3a4b5c6d-7e8f-4a1b-9c2d-0e1f2a3b4c5d.jsonl',
);

/** A scratch dir with a private copy of the fixtures, so tests can modify them. */
export const QW_MAIN = join(QWEN_FIXTURES, 'projects/-Users-alice-code-acme-shop/chats/5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61.jsonl');
export const QW_SUBAGENT = join(
  QWEN_FIXTURES,
  'projects/-Users-alice-code-acme-shop/subagents/5d2c8e41-7a3b-4c6d-9e0f-1a2b3c4d5e61/agent-explore-7f3c.jsonl',
);
export const QW_DEEPSEEK = join(QWEN_FIXTURES, 'projects/-Users-alice-code-blog/chats/8f7e6d5c-4b3a-4291-8e7f-6d5c4b3a2f72.jsonl');

export function scratch(): { dir: string; claude: string; codex: string; qwen: string; home: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'contextdeck-test-'));
  const claude = join(dir, 'claude');
  const codex = join(dir, 'codex');
  cpSync(CLAUDE_FIXTURES, claude, { recursive: true });
  const qwen = join(dir, 'qwen');
  cpSync(CODEX_FIXTURES, codex, { recursive: true });
  cpSync(QWEN_FIXTURES, qwen, { recursive: true });
  return { dir, claude, codex, qwen, home: join(dir, 'home'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
