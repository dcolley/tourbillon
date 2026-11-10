/**
 * #348 C5 + C8 — network guard unit tests.
 *
 * The guard's ONLY source of truth is the socket remote address. Tests inject
 * the socket directly (that is what the route does from the transport) and set
 * headers separately: every case pins that client-supplied X-Forwarded-For /
 * X-Real-IP / Forwarded / X-Forwarded-Host NEVER flip a deny into an allow.
 *
 * Addresses are RFC 5737 documentation ranges (192.0.2.0/24 = "LAN",
 * 198.51.100.0/24 = non-allowlisted) — no real site addresses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideStudioAccess,
  ipInCidr,
  normalizeSocketAddress,
  type StudioEnv,
} from '@tourbillon/shared/mastra-studio';

const LAN = '192.0.2.0/24'; // RFC 5737 documentation range stands in for <lan-cidr>
const ENV: StudioEnv = {
  MASTRA_STUDIO_ALLOWED_CIDRS: LAN,
  MASTRA_STUDIO_TRUSTED_PROXY: '198.51.100.9', // pinned nginx hop stand-in
  MASTRA_STUDIO_PUBLIC_HOSTS: 'studio-public.example',
};

const LAN_SOCKET = '192.0.2.50';
const PUBLIC_SOCKET = '198.51.100.77'; // outside LAN, outside CGNAT, not the proxy
const PROXY_SOCKET = '198.51.100.9';

function allow(socket: string | null, headers: Record<string, string | undefined> = {}, env = ENV) {
  return decideStudioAccess({ socketRemoteAddress: socket, headers }, env).allow;
}

describe('#348 C5 forged forwarded requests (socket is the only truth)', () => {
  it('C5a: X-Forwarded-For claiming LAN from a public socket → DENY; from the trusted proxy → DENY', () => {
    assert.equal(allow(PUBLIC_SOCKET, { 'x-forwarded-for': '192.0.2.50' }), false);
    assert.equal(allow(PROXY_SOCKET, { 'x-forwarded-for': '192.0.2.50' }), false);
    assert.equal(allow('127.0.0.1', { 'x-forwarded-for': '192.0.2.50' }), false);
  });

  it('C5b: X-Real-IP claiming LAN → DENY', () => {
    assert.equal(allow(PUBLIC_SOCKET, { 'x-real-ip': '192.0.2.50' }), false);
    assert.equal(allow('127.0.0.1', { 'x-real-ip': '192.0.2.50' }), false);
    assert.equal(allow(PROXY_SOCKET, { 'x-real-ip': '192.0.2.50' }), false);
  });

  it('C5c: RFC 7239 Forwarded claiming LAN → DENY', () => {
    assert.equal(allow(PUBLIC_SOCKET, { forwarded: 'for=192.0.2.50;proto=http' }), false);
    assert.equal(allow('127.0.0.1', { forwarded: 'for=192.0.2.50' }), false);
  });

  it('C5d: X-Forwarded-Host = LAN / Studio origin from public socket or proxy hop → DENY', () => {
    assert.equal(
      allow(PUBLIC_SOCKET, { 'x-forwarded-host': '192.0.2.10:3002' }),
      false,
      'public socket + LAN forwarded host',
    );
    // The proxy hop with ANY proxy signature is always public — the LAN value
    // is never "recovered".
    assert.equal(allow('127.0.0.1', { 'x-forwarded-host': '192.0.2.10:3002' }), false);
    assert.equal(allow('127.0.0.1', { 'x-forwarded-host': 'http://192.0.2.10:4111' }), false);
  });

  it('public Host (or public X-Forwarded-Host) 404s even from a LAN-looking socket', () => {
    assert.equal(allow(LAN_SOCKET, { host: 'studio-public.example' }), false);
    assert.equal(allow(LAN_SOCKET, { host: 'Studio-Public.Example:443' }), false);
    assert.equal(allow(LAN_SOCKET, { 'x-forwarded-host': 'studio-public.example' }), false);
  });

  it('C5e: ::1 header or non-allowlisted v6 socket → DENY; real ::1 socket without proxy signature → ALLOW (on-box curl)', () => {
    assert.equal(allow(PUBLIC_SOCKET, { 'x-forwarded-for': '::1' }), false);
    assert.equal(allow('::ffff:203.0.113.9', {}), false, // documented non-allowlisted v6-mapped
    );
    assert.equal(allow('::1', {}), true);
    assert.equal(allow('::1', { 'x-forwarded-for': '192.0.2.50' }), false, '::1 via nginx is public');
  });

  it('C5f: IPv4-mapped sockets unmap both ways', () => {
    assert.equal(allow('::ffff:198.51.100.8', {}), false, 'mapped public → deny');
    assert.equal(allow('::ffff:192.0.2.50', {}), true, 'mapped LAN → allow');
    assert.equal(allow('::ffff:100.64.5.6', {}), true, 'mapped Tailscale CGNAT → allow');
  });

  it('C5g: spoofed leftmost XFF chain → DENY (never trust a hop)', () => {
    assert.equal(allow(PUBLIC_SOCKET, { 'x-forwarded-for': '192.0.2.50, 198.51.100.9' }), false);
    assert.equal(allow(PROXY_SOCKET, { 'x-forwarded-for': '192.0.2.50, 8.8.8.8' }), false);
    assert.equal(allow('127.0.0.1', { 'x-forwarded-for': '192.0.2.50, 127.0.0.1' }), false);
  });

  it('C5h: source-of-truth pins — no-socket fails closed; direct loopback allowed; trusted proxy without proxy-signature is the pinned nginx hop', () => {
    assert.equal(allow(null, {}), false);
    assert.equal(allow('', {}), false);
    assert.equal(allow('not-an-ip', {}), false);
    // On-box curl to :3002 (no proxy involved) is allowed.
    assert.equal(allow('127.0.0.1', { host: '127.0.0.1:3002' }), true);
    // The pinned proxy hop presenting no forwarded headers is still the proxy
    // configuration; treat exactly like loopback-direct (it never forwards
    // Studio traffic: nginx 404s it first — defence in depth, not auth).
    assert.equal(allow(PROXY_SOCKET, { host: '198.51.100.9:3002' }), true);
    // LAN + Tailscale sockets are allowed on the socket alone.
    assert.equal(allow(LAN_SOCKET, {}), true);
    assert.equal(allow('100.96.10.11', {}), true, 'Tailscale CGNAT 100.64.0.0/10');
    assert.equal(allow('100.127.255.255', {}), true);
    assert.equal(allow('100.128.0.1', {}), false, 'first IP outside /10');
    assert.equal(allow(PUBLIC_SOCKET, {}), false);
  });

  it('direct-local vs nginx-forwarded on the loopback socket (Next backfill semantics)', () => {
    const clean = {
      host: '127.0.0.1:3002',
      // What Next itself sets for a DIRECT connection (base-server ??=):
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': '127.0.0.1:3002',
      'x-forwarded-proto': 'http',
      'x-forwarded-port': '3002',
    };
    assert.equal(allow('127.0.0.1', clean), true, 'Next-backfilled direct request is local');
    assert.equal(allow('127.0.0.1', { ...clean, 'x-forwarded-for': '::ffff:127.0.0.1' }), true, 'mapped form ok');
    // Any proxy evidence on this socket ⇒ public:
    assert.equal(allow('127.0.0.1', { ...clean, 'x-real-ip': '8.8.8.8' }), false, 'x-real-ip is proxy-only');
    assert.equal(allow('127.0.0.1', { ...clean, forwarded: 'for=8.8.8.8' }), false, 'Forwarded is proxy-only');
    assert.equal(allow('127.0.0.1', { ...clean, 'x-forwarded-for': '198.51.100.77' }), false, 'nginx XFF = public client');
    assert.equal(allow('127.0.0.1', { ...clean, 'x-forwarded-for': '127.0.0.1, 127.0.0.1' }), false, 'two-hop chain');
    assert.equal(allow('127.0.0.1', { ...clean, 'x-forwarded-host': 'public.example' }), false, 'XFH != Host');
    assert.equal(allow('127.0.0.1', { ...clean, 'x-forwarded-host': '192.0.2.170:3002' }), false, 'LAN-claiming XFH');
    // Self-claim XFF from loopback equals the socket: same trust as direct.
    assert.equal(allow('127.0.0.1', { host: '127.0.0.1:3002', 'x-forwarded-for': '127.0.0.1' }), true);
  });

  it('guard never READS header values for the allow decision (headers cannot widen)', () => {
    // Same socket, headers stuffed with every LAN claim — verdict identical to bare.
    const bare = decideStudioAccess({ socketRemoteAddress: PUBLIC_SOCKET, headers: {} }, ENV);
    const stuffed = decideStudioAccess(
      {
        socketRemoteAddress: PUBLIC_SOCKET,
        headers: {
          'x-forwarded-for': '192.0.2.50, 100.64.0.1, 127.0.0.1, ::1',
          'x-real-ip': '192.0.2.50',
          forwarded: 'for=192.0.2.50;by=192.0.2.1',
          'x-forwarded-host': '192.0.2.10:3002',
        },
      },
      ENV,
    );
    assert.deepEqual(stuffed, bare);
  });
});

describe('#348 — IP helpers', () => {
  it('unmaps IPv4-mapped IPv6 and rejects garbage', () => {
    assert.equal(normalizeSocketAddress('::ffff:192.0.2.5'), '192.0.2.5');
    assert.equal(normalizeSocketAddress('::FFFF:192.0.2.5'), '192.0.2.5');
    assert.equal(normalizeSocketAddress('192.0.2.5%eth0'), '192.0.2.5');
    assert.equal(normalizeSocketAddress('fe80::1%eth0'), 'fe80::1');
    assert.equal(normalizeSocketAddress('999.1.1.1'), null);
    assert.equal(normalizeSocketAddress('192.0.2'), null);
    assert.equal(normalizeSocketAddress(undefined), null);
    assert.equal(normalizeSocketAddress(null), null);
  });

  it('CIDR matching for v4 and v6, family-safe', () => {
    assert.equal(ipInCidr('192.0.2.50', '192.0.2.0/24'), true);
    assert.equal(ipInCidr('192.0.3.1', '192.0.2.0/24'), false);
    assert.equal(ipInCidr('100.64.0.1', '100.64.0.0/10'), true);
    assert.equal(ipInCidr('100.127.255.254', '100.64.0.0/10'), true);
    assert.equal(ipInCidr('100.128.0.0', '100.64.0.0/10'), false);
    assert.equal(ipInCidr('203.0.113.5', 'fd00::/8'), false, 'family mismatch');
    assert.equal(ipInCidr('fd12::34', 'fd00::/8'), true);
    assert.equal(ipInCidr('fe80::1', 'fd00::/8'), false);
    assert.equal(ipInCidr('192.0.2.5', '192.0.2.5/32'), true);
    assert.equal(ipInCidr('192.0.2.6', '192.0.2.5/32'), false);
  });
});
