import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REDACTED, redact } from '../src/util/redact.js';

// Fake secrets are assembled at runtime so no secret-looking string is committed
// (GitHub push protection would otherwise flag the test file).
const j = (...parts: string[]) => parts.join('');
const tail = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';

describe('redact', () => {
  const cases: [string, string][] = [
    ['Anthropic key', j('sk-', 'ant-', 'api03-', tail)],
    ['OpenAI key', j('sk-', 'proj-', tail)],
    ['GitHub token', j('gh', 'p_', tail, 'zz')],
    ['AWS key id', j('AK', 'IA', 'ABCDEFGHIJKLMNOP')],
    ['Google key', j('AI', 'za', 'Sy', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q')],
    ['Slack token', j('xo', 'xb-', '1234567890-abcdefghij')],
    ['Stripe key', j('sk', '_live_', tail)],
    ['JWT', j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.', 'abcdefghijklmnop')],
  ];
  for (const [name, secret] of cases) {
    it(`removes a ${name}`, () => {
      const out = redact(`before ${secret} after`);
      assert.ok(!out.includes(secret), out);
      assert.match(out, /before \[REDACTED\] after/);
    });
  }

  it('keeps the variable name in KEY=value assignments', () => {
    assert.equal(redact('DATABASE_PASSWORD=hunter2hunter2'), `DATABASE_PASSWORD=${REDACTED}`);
    assert.equal(redact('"api_key": "abcdef123456"'), `"api_key": "${REDACTED}"`);
    assert.equal(redact('STRIPE_SECRET_KEY: abcdefgh1234'), `STRIPE_SECRET_KEY: ${REDACTED}`);
  });

  it('redacts bearer tokens and URL credentials but keeps the shape', () => {
    assert.equal(redact('Authorization: Bearer abcdefghijklmnop1234'), `Authorization: Bearer ${REDACTED}`);
    assert.equal(
      redact('postgres://app:s3cr3tpass@db.internal:5432/shop'),
      `postgres://app:${REDACTED}@db.internal:5432/shop`,
    );
  });

  it('redacts private key blocks, even when truncated', () => {
    const block = j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA ', 'PRIVATE KEY-----');
    assert.equal(redact(`key:\n${block}\nok`), `key:\n${REDACTED}\nok`);
    assert.equal(redact(j('-----BEGIN ', 'PRIVATE KEY-----\nMIIEow')), REDACTED);
  });

  it('leaves ordinary code and prose alone', () => {
    const samples = [
      'const token = getToken(); // returns the session token\nexport function refresh(req) {}',
      'const apiKey = process.env.OPENAI_API_KEY;',
      'interface Login { password: string; token?: string }',
      'csrfToken = readCookie(req, "csrf")',
      'task-runner sk-ip the tests',
    ];
    for (const text of samples) assert.equal(redact(text), text);
  });
});
