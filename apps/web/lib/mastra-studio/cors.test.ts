/**
 * #348 C6 — CORS: exact Studio origin only. No '*', no reflection of un-listed
 * origins, no credentials, Vary: Origin, correct preflight. The contract's
 * real addresses are replaced by the same PLACEHOLDER-STYLE values Ops would
 * configure (RFC 5737 + example domain — no real internal addresses).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalOrigin,
  studioCorsHeadersFor,
  studioCorsOrigins,
  studioPreflightHeaders,
  STUDIO_CORS_METHODS,
} from '@tourbillon/shared/mastra-studio';

const STUDIO_ORIGIN = 'http://192.0.2.170:4111';
const TAILSCALE_ORIGIN = 'http://100.96.10.11:4111';
const ENV = {
  MASTRA_STUDIO_ORIGIN: STUDIO_ORIGIN,
  MASTRA_STUDIO_ALLOWED_ORIGINS: TAILSCALE_ORIGIN,
};

describe('#348 C6 CORS allowlist', () => {
  it('C6a: preflight for the Studio origin → ACAO exact + Vary + methods (GET/POST/OPTIONS)', () => {
    const h = studioPreflightHeaders(STUDIO_ORIGIN, ENV);
    assert.ok(h);
    assert.equal(h['access-control-allow-origin'], STUDIO_ORIGIN);
    assert.equal(h.vary, 'Origin');
    assert.equal(h['access-control-allow-methods'], STUDIO_CORS_METHODS);
    assert.match(h['access-control-allow-methods'], /GET/);
    assert.match(h['access-control-allow-methods'], /POST/);
    assert.match(h['access-control-allow-methods'], /OPTIONS/);
    assert.ok(h['access-control-allow-headers']);
  });

  it('C6b: actual GET decision carries ACAO too (not preflight-only)', () => {
    const h = studioCorsHeadersFor(STUDIO_ORIGIN, ENV);
    assert.deepEqual(h, { 'access-control-allow-origin': STUDIO_ORIGIN, vary: 'Origin' });
  });

  it('C6c: disallowed origin gets NO ACAO (never a reflection)', () => {
    assert.equal(studioCorsHeadersFor('https://evil.example', ENV), null);
    assert.equal(studioCorsHeadersFor('http://192.0.2.99:4111', ENV), null);
  });

  it('C6d: Origin: null → no ACAO', () => {
    assert.equal(studioCorsHeadersFor('null', ENV), null);
    assert.equal(studioCorsHeadersFor('NULL', ENV), null);
  });

  it('C6e: the wildcard is never emitted, even if misconfigured into the allowlist', () => {
    const h = studioCorsHeadersFor('*', ENV);
    assert.equal(h, null);
    const envStar = { MASTRA_STUDIO_ORIGIN: '*' };
    assert.deepEqual(studioCorsOrigins(envStar), [], "'*' is not a canonical origin");
    assert.equal(studioCorsHeadersFor('https://anything.example', envStar), null);
  });

  it('C6f: credentials are never advertised', () => {
    const pre = studioPreflightHeaders(STUDIO_ORIGIN, ENV);
    const get = studioCorsHeadersFor(STUDIO_ORIGIN, ENV);
    for (const headers of [pre, get]) {
      assert.ok(headers);
      const creds = Object.keys(headers).find(
        (k) => k.toLowerCase() === 'access-control-allow-credentials',
      );
      assert.equal(creds, undefined, 'must not advertise credentials');
    }
  });

  it('C6g: suffix / prefix / scheme / port tricks and the Tailscale origin (unless allowlisted) → no ACAO', () => {
    const bad = [
      'https://192.0.2.170.evil.example:4111', // suffix of allowed host label
      'http://evil-192.0.2.170:4111', // prefix look-alike
      'http://192.0.2.170:41110', // port typo
      'https://192.0.2.170:4111', // scheme swap
      'http://192.0.2.170', // missing port
      'http://192.0.2.170:4111/', // path — canonicalises equal, so ALLOWED below
      'http://192.0.2.170:4111/studio', // path must be REJECTED as an origin
      'http://100.96.10.11:4111', // Tailscale origin — allowed only via config
    ];
    for (const origin of bad.slice(0, 5)) {
      assert.equal(studioCorsHeadersFor(origin, ENV), null, `${origin} must get no ACAO`);
    }
    // Canonical path-less origin matches; a path-bearing origin never matches.
    assert.ok(studioCorsHeadersFor('http://192.0.2.170:4111/', ENV));
    assert.equal(studioCorsHeadersFor('http://192.0.2.170:4111/studio', ENV), null);
    // Tailscale origin: allowed here because the env allowlists it…
    assert.equal(studioCorsHeadersFor(TAILSCALE_ORIGIN, ENV)?.['access-control-allow-origin'], TAILSCALE_ORIGIN);
    // …and 404'd-no-ACAO when it is not configured (Q6: explicit allowlist only).
    assert.equal(studioCorsHeadersFor(TAILSCALE_ORIGIN, { MASTRA_STUDIO_ORIGIN: STUDIO_ORIGIN }), null);
  });

  it('allowlist is exact-match set membership (no startsWith/endsWith anywhere)', () => {
    // The classic endsWith('192.0.2.170:4111') mutant:
    assert.equal(studioCorsHeadersFor('http://evil.com/192.0.2.170:4111', ENV), null);
    assert.equal(studioCorsHeadersFor(`http://192.0.2.170:4111@evil.example`, ENV), null);
  });

  it('canonicalOrigin normalises case and rejects non-http(s)', () => {
    assert.equal(canonicalOrigin('HTTP://192.0.2.170:4111'), 'http://192.0.2.170:4111');
    assert.equal(canonicalOrigin('http://192.0.2.170:4111/?x=1'), null);
    assert.equal(canonicalOrigin('http://192.0.2.170:4111#f'), null);
    assert.equal(canonicalOrigin('ftp://192.0.2.170:4111'), null);
    assert.equal(canonicalOrigin('not a url'), null);
  });

  it('malformed configured origins are dropped, not honoured', () => {
    assert.deepEqual(studioCorsOrigins({ MASTRA_STUDIO_ORIGIN: 'garbage', MASTRA_STUDIO_ALLOWED_ORIGINS: 'ok,http://a.example:1' }), ['http://a.example:1']);
  });
});
