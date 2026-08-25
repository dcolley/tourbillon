import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { publicOriginFromRequest } from '@tourbillon/shared';

/**
 * Unit tests for approval decide route redirect URL construction.
 * 
 * These tests verify that HTML form POST requests (Accept: text/html) to
 * POST /api/approvals/:id/decide will redirect to an absolute URL built
 * from publicOriginFromRequest(req), never using req.url which contains
 * the listen address (0.0.0.0:3002).
 * 
 * The actual route implementation is in route.ts line ~159:
 *   return NextResponse.redirect(new URL('/approval', publicOriginFromRequest(req)), 303);
 */

function createMockHeaders(entries: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(entries)) {
    headers.set(key, value);
  }
  return headers;
}

describe('Approval decide redirect URL construction', () => {
  it('constructs absolute URL for LAN host', () => {
    const headers = createMockHeaders({
      host: '192.168.10.170:3002',
    });
    const req = {
      headers,
      url: 'http://0.0.0.0:3002/api/approvals/test/decide',
    };

    const origin = publicOriginFromRequest(req);
    const redirectUrl = new URL('/approval', origin);

    assert.equal(redirectUrl.toString(), 'http://192.168.10.170:3002/approval');
    assert.ok(!redirectUrl.toString().includes('0.0.0.0'));
  });

  it('constructs absolute URL for Tailscale host', () => {
    const headers = createMockHeaders({
      host: '100.118.152.28:3002',
    });
    const req = {
      headers,
      url: 'http://0.0.0.0:3002/api/approvals/test/decide',
    };

    const origin = publicOriginFromRequest(req);
    const redirectUrl = new URL('/approval', origin);

    assert.equal(redirectUrl.toString(), 'http://100.118.152.28:3002/approval');
    assert.ok(!redirectUrl.toString().includes('0.0.0.0'));
    assert.ok(!redirectUrl.toString().includes('127.0.0.1'));
  });

  it('constructs absolute URL with x-forwarded-host', () => {
    const headers = createMockHeaders({
      host: '0.0.0.0:3002',
      'x-forwarded-host': 'tourbillon.example.com',
      'x-forwarded-proto': 'https',
    });
    const req = {
      headers,
      url: 'http://0.0.0.0:3002/api/approvals/test/decide',
    };

    const origin = publicOriginFromRequest(req);
    const redirectUrl = new URL('/approval', origin);

    assert.equal(redirectUrl.toString(), 'https://tourbillon.example.com/approval');
    assert.ok(!redirectUrl.toString().includes('0.0.0.0'));
  });

  it('constructs absolute URL for localhost', () => {
    const headers = createMockHeaders({
      host: 'localhost:3002',
    });
    const req = {
      headers,
      url: 'http://0.0.0.0:3002/api/approvals/test/decide',
    };

    const origin = publicOriginFromRequest(req);
    const redirectUrl = new URL('/approval', origin);

    assert.equal(redirectUrl.toString(), 'http://localhost:3002/approval');
  });

  it('throws when only listen address is available', () => {
    const headers = createMockHeaders({
      host: '0.0.0.0:3002',
    });
    const req = {
      headers,
      url: 'http://0.0.0.0:3002/api/approvals/test/decide',
    };

    assert.throws(
      () => publicOriginFromRequest(req),
      /Cannot derive public origin.*listen addresses/,
      'Should reject pure listen address',
    );
  });
});
