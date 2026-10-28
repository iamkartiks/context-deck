/**
 * Secret redaction, applied to every piece of text before it reaches the index.
 *
 * Transcripts routinely contain API keys, tokens and .env contents that the
 * agent read or printed. The index is local, but it is also what a future UI,
 * export or summariser will read, so secrets are stripped at the door.
 *
 * Patterns err on the side of redacting too much. Add new ones with a test
 * in test/redact.test.ts.
 */

interface Rule {
  name: string;
  pattern: RegExp;
  /** Replace the whole match, or keep a prefix group ($1) and redact the rest. */
  keepPrefix?: boolean;
}

const RULES: Rule[] = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  // Anthropic, OpenAI and similar "sk-" style keys
  { name: 'sk-key', pattern: /\bsk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  // GitHub tokens
  { name: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  // AWS access key ids
  { name: 'aws-key-id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // Google API keys
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Slack tokens
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // Stripe keys
  { name: 'stripe-key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  // JWTs
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Authorization: Bearer <token>
  { name: 'bearer', pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, keepPrefix: true },
  // Credentials inside URLs: scheme://user:password@host
  { name: 'url-credentials', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi, keepPrefix: true },
  // KEY=value / KEY: value where the name looks secret (.env files, configs).
  // The value must look like a literal secret (contains a digit, not a call like
  // getToken()), so ordinary code such as `const token = getToken()` is left alone.
  {
    name: 'secret-assignment',
    pattern:
      /(\b[A-Za-z0-9_.-]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)(?=[^\s"',;()]*\d)[^\s"',;()]{6,}(?!\()/gi,
    keepPrefix: true,
  },
];

export const REDACTED = '[REDACTED]';

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match, prefix?: unknown) => {
      if (rule.keepPrefix && typeof prefix === 'string') return prefix + REDACTED;
      return REDACTED;
    });
  }
  return out;
}
