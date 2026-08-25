import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { publicOriginFromRequest } from './request-origin';

function createMockHeaders(entries: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(entries)) {
    headers.set(key, value);
  }
  return headers;
}

describe('publicOriginFromRequest', () => {
  describe('rejects listen addresses', () => {
    it('throws when only 0.0.0.0 host is available', () => {
      const req = {
        headers: createMockHeaders({ host: '0.0.0.0:3002' }),
      };
      assert.throws(
        () => publicOriginFromRequest(req),
        /Cannot derive public origin.*listen addresses/,
      );
    });

    it('throws when only :: host is available', () => {
      const req = {
        headers: createMockHeaders({ host: '::' }),
      };
      assert.throws(
        () => publicOriginFromRequest(req),
        /Cannot derive public origin.*listen addresses/,
      );
    });

    it('throws when only [::] host is available', () => {
      const req = {
        headers: createMockHeaders({ host: '[::]:3002' }),
      };
      assert.throws(
        () => publicOriginFromRequest(req),
        /Cannot derive public origin.*listen addresses/,
      );
    });

    it('throws when origin contains 0.0.0.0', () => {
      const req = {
        headers: createMockHeaders({ origin: 'http://0.0.0.0:3002' }),
      };
      assert.throws(
        () => publicOriginFromRequest(req),
        /Cannot derive public origin.*listen addresses/,
      );
    });
  });

  describe('prefers Origin header', () => {
    it('returns origin when present and valid', () => {
      const req = {
        headers: createMockHeaders({
          origin: 'http://192.168.10.170:3002',
          host: '0.0.0.0:3002',
        }),
      };
      assert.equal(publicOriginFromRequest(req), 'http://192.168.10.170:3002');
    });

    it('returns origin for Tailscale address', () => {
      const req = {
        headers: createMockHeaders({
          origin: 'http://100.118.152.28:3002',
        }),
      };
      assert.equal(publicOriginFromRequest(req), 'http://100.118.152.28:3002');
    });

    it('returns origin for localhost', () => {
      const req = {
        headers: createMockHeaders({
          origin: 'http://localhost:3002',
        }),
      };
      assert.equal(publicOriginFromRequest(req), 'http://localhost:3002');
    });
  });

  describe('falls back to x-forwarded-host', () => {
    it('uses x-forwarded-host with x-forwarded-proto', () => {
      const req = {
        headers: createMockHeaders({
          'x-forwarded-host': '192.168.10.170:3002',
          'x-forwarded-proto': 'https',
        }),
      };
      assert.equal(publicOriginFromRequest(req), 'https://192.168.10.170:3002');
    });

    it('defaults to http when x-forwarded-proto is missing', () => {
      const req = {
        headers: createMockHeaders({
          'x-forwarded-host': '192.168.10.170:3002',
        }),
      };
      assert.equal(publicOriginFromRequest(req), 'http://192.168.10.170:3002');
    });

    it('uses origin protocol when x-forwarded-proto is missing', () => {
      const req = {
        headers: createMockHeaders({
          origin: 'https://other-host:8080',
          'x-forwarded-host': '192.168.10.170:3002',
        }),
      };
      assert.equal(publicOriginFromRequest(req), 'https://192.168.10.170:3002');
    });

    it('rejects x-forwarded-host when it is a listen address', () => {
      const req = {
        headers: createMockHeaders({
          'x-forwarded-host': '0.0.0.0:3002',
          host: 'localhost:3002',
        }),
      };
      // Should fall through to host
      assert.equal(publicOriginFromRequest(req), 'http://localhost:3002');
    });
  });

  describe('falls back to Host header', () => {
    it('uses host header when others are unavailable', () => {
      const req = {
        headers: createMockHeaders({
          host: '192.168.10.170:3002',
        }),
      };
      assert.equal(publicOriginFromRequest(req), 'http://192.168.10.170:3002');
    });

    it('uses host header with origin protocol', () => {
      const req = {
        headers: createMockHeaders({
          origin: 'https://example.com',
          host: '192.168.10.170:3002',
        }),
      };
      // Origin is rejected (different host), falls back to host with origin's protocol
      assert.equal(publicOriginFromRequest(req), 'https://192.168.10.170:3002');
    });

    it('uses Tailscale host', () => {
      const req = {
        headers: createMockHeaders({
          host: '100.118.152.28:3002',
        }),
      };
      assert.equal(publicOriginFromRequest(req), 'http://100.118.152.28:3002');
    });
  });

  describe('req.url fallback', () => {
    it('uses req.url when headers are unavailable', () => {
      const req = {
        headers: createMockHeaders({}),
        url: 'http://192.168.10.170:3002/some/path',
      };
      assert.equal(publicOriginFromRequest(req), 'http://192.168.10.170:3002');
    });

    it('rejects req.url with listen address', () => {
      const req = {
        headers: createMockHeaders({}),
        url: 'http://0.0.0.0:3002/some/path',
      };
      assert.throws(
        () => publicOriginFromRequest(req),
        /Cannot derive public origin.*listen addresses/,
      );
    });
  });
});
