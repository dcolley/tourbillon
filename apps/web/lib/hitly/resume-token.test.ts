import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateResumeToken,
  hashResumeToken,
  readResumeCredential,
  resumeTokenExpiry,
  resumeTokenMatches,
  RESUME_TOKEN_HEADER,
  RESUME_TOKEN_TTL_MS,
} from './resume-token';

const req = (url: string, headers: Record<string, string> = {}) => ({ url, headers: new Headers(headers) });

describe('HITLy resume token helpers', () => {
  it('generates distinct url-safe tokens', () => {
    const a = generateResumeToken();
    const b = generateResumeToken();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  });

  it('digest is hex SHA-256 and never contains the token', () => {
    const t = generateResumeToken();
    const h = hashResumeToken('appr-1', t);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!h.includes(t));
  });

  it('matches only the same token for the same approval', () => {
    const t = generateResumeToken();
    const h = hashResumeToken('appr-1', t);
    assert.equal(resumeTokenMatches('appr-1', t, h), true);
    assert.equal(resumeTokenMatches('appr-1', `${t}x`, h), false);
    assert.equal(resumeTokenMatches('appr-2', t, h), false, 'digest is bound to the approval id');
    assert.equal(resumeTokenMatches('appr-1', t, t), false, 'a plaintext value is not a digest');
    assert.equal(resumeTokenMatches('appr-1', t, null), false);
    assert.equal(resumeTokenMatches('appr-1', t, ''), false);
  });

  it('expiry is the TTL from now', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    assert.equal(resumeTokenExpiry(now).getTime() - now.getTime(), RESUME_TOKEN_TTL_MS);
  });

  describe('readResumeCredential', () => {
    const url = 'https://tb.example/api/approvals/a/hitly-resume';
    it('reads the query parameter', () => {
      assert.deepEqual(readResumeCredential(req(`${url}?token=abc`)), { ok: true, token: 'abc', source: 'query' });
    });
    it('prefers the header', () => {
      assert.deepEqual(readResumeCredential(req(url, { [RESUME_TOKEN_HEADER]: 'abc' })), {
        ok: true,
        token: 'abc',
        source: 'header',
      });
    });
    it('refuses a header/query mismatch', () => {
      const r = readResumeCredential(req(`${url}?token=one`, { [RESUME_TOKEN_HEADER]: 'two' }));
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.status, 400);
    });
    it('refuses a missing or oversized token', () => {
      const missing = readResumeCredential(req(url));
      assert.equal(!missing.ok && missing.status, 401);
      const huge = readResumeCredential(req(`${url}?token=${'a'.repeat(300)}`));
      assert.equal(!huge.ok && huge.status, 401);
    });
    for (const [label, headers] of [
      ['Authorization bearer', { authorization: 'Bearer pm_run_x' }],
      ['company token header', { 'x-company-token': 'jwt' }],
      ['board session cookie', { cookie: 'a=b; tourbillon_board_session=s' }],
    ] as const) {
      it(`refuses requests carrying a Tourbillon credential (${label})`, () => {
        const r = readResumeCredential(req(`${url}?token=abc`, headers));
        assert.equal(r.ok, false);
        assert.equal(!r.ok && r.status, 403);
      });
    }
  });
});
