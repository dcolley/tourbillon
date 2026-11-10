/**
 * #348 — internal-only Mastra Studio.
 *
 * Pure, stdlib-only decision helpers so every security-relevant rule is unit
 * testable without Next, the DB or the network:
 *
 *  - the `MASTRA_API_ENABLED` flag (on ONLY when the value is exactly 'true',
 *    same convention as OBSERVABILITY_ENABLED);
 *  - the network guard (source of truth = the TCP socket remote address, never
 *    X-Forwarded-For / X-Real-IP / Forwarded / X-Forwarded-Host);
 *  - the CORS allowlist (exact Studio origin match, no wildcard, no reflection
 *    of un-listed origins, no credentials);
 *  - the path allowlist (only the agents list/detail/tools + generate/stream
 *    surfaces; memory and tool-execute stay 404 even with the flag on);
 *
 * NOTHING here may take an allow/deny decision from client-supplied forwarded
 * headers; see decideStudioAccess. `publicOriginFromRequest` (request-origin.ts)
 * trusts X-Forwarded-Host and must never be used for this guard.
 *
 * All site-specific addresses come from env config — this module carries no
 * private-IP defaults. The only hardcoded range is the RFC 6598 CGNAT block
 * used by Tailscale (a standards-defined range, not a site address).
 */

export type StudioEnv = Record<string, string | undefined>;

/**
 * C1a-f: the Studio/Mastra HTTP API is enabled ONLY when the value is exactly
 * 'true'. Unset, empty, 'false', '0', 'TRUE', 'True', '1', 'yes', 'ture' and
 * every other typo mean OFF.
 */
export function isMastraStudioApiEnabled(env: StudioEnv = process.env): boolean {
  return env.MASTRA_API_ENABLED === 'true';
}

/**
 * RFC 6598 CGNAT block — the address space Tailscale allocates from. Not a
 * site-specific address, so it is a constant here rather than env config.
 */
export const TAILSCALE_CGNAT_IPV4_CIDR = '100.64.0.0/10';

function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** MASTRA_STUDIO_ALLOWED_CIDRS — comma-separated CIDRs (LAN ranges). No defaults. */
export function studioAllowedCidrs(env: StudioEnv = process.env): string[] {
  return splitList(env.MASTRA_STUDIO_ALLOWED_CIDRS);
}

/** MASTRA_STUDIO_TRUSTED_PROXY — the pinned nginx hop address(es). No defaults. */
export function studioTrustedProxies(env: StudioEnv = process.env): string[] {
  return splitList(env.MASTRA_STUDIO_TRUSTED_PROXY)
    .map((s) => normalizeSocketAddress(s))
    .filter((s): s is string => s !== null);
}

/** MASTRA_STUDIO_PUBLIC_HOSTS — public hostnames (port-insensitive, lowercase). */
export function studioPublicHosts(env: StudioEnv = process.env): string[] {
  return splitList(env.MASTRA_STUDIO_PUBLIC_HOSTS).map((h) => hostnameOf(h));
}

// ---------------------------------------------------------------------------
// IP / CIDR primitives
// ---------------------------------------------------------------------------

function isIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return Boolean(m) && m!.slice(1).every((p) => Number(p) <= 255 && String(Number(p)) === p);
}

/** Expand an IPv6 address to 8 groups of 16-bit hex (handles `::` and embedded v4). */
function expandIpv6(addr: string): string[] | null {
  let a = addr.toLowerCase();
  const v4tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (v4tail) {
    if (!isIPv4(v4tail[1])) return null;
    const oct = v4tail[1].split('.').map(Number);
    const hex = (hi: number, lo: number) =>
      ((hi << 8) | lo).toString(16).padStart(4, '0');
    a = a.slice(0, v4tail.index! + 1) + `${hex(oct[0], oct[1])}:${hex(oct[2], oct[3])}`;
  }
  if (!/^[0-9a-f:.]+$/.test(a)) return null;
  const sides = a.split('::');
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(':') : [];
  const tail = sides[1] !== undefined ? (sides[1] ? sides[1].split(':') : []) : null;
  if (sides.length === 2) {
    const missing = 8 - head.length - tail!.length;
    if (missing < 0) return null;
    return [...head, ...Array(missing).fill('0'), ...tail!].map((g) => g.padStart(4, '0'));
  }
  if (head.length !== 8 || head.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return head.map((g) => g.padStart(4, '0'));
}

function isIPv6(addr: string): boolean {
  return expandIpv6(addr) !== null && addr.includes(':');
}

/**
 * Unmap IPv4-mapped IPv6 (`::ffff:a.b.c.d` → `a.b.c.d`), strip IPv6 zones,
 * normalise case. Returns null for anything that is not a clean IP — the
 * guard fails closed on null (C5f: unmapping must work both ways).
 */
export function normalizeSocketAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let ip = raw.trim();
  if (!ip) return null;
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(ip);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (isIPv4(ip)) return ip;
  if (expandIpv6(ip)) return ip.toLowerCase();
  return null;
}

function ipv4Bytes(ip: string): number[] {
  return ip.split('.').map(Number);
}

function ipv6Bytes(addr: string): number[] | null {
  const groups = expandIpv6(addr);
  if (!groups) return null;
  const out: number[] = [];
  for (const g of groups) {
    const v = parseInt(g, 16);
    out.push((v >> 8) & 0xff, v & 0xff);
  }
  return out;
}

/**
 * CIDR containment for IPv4 and IPv6 (byte-prefix compare). A family mismatch
 * (v4 IP vs v6 CIDR) never matches.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/');
  if (!net || bitsRaw === undefined) return false;
  const bits = Number(bitsRaw);
  const v4 = isIPv4(ip);
  if (v4) {
    if (!isIPv4(net) || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const a = ipv4Bytes(ip);
    const b = ipv4Bytes(net);
    for (let i = 0; i < 4; i++) {
      const used = Math.max(0, Math.min(8, bits - i * 8));
      if (used === 0) break;
      const mask = (0xff << (8 - used)) & 0xff;
      if ((a[i] & mask) !== (b[i] & mask)) return false;
    }
    return true;
  }
  if (!isIPv6(ip) || !isIPv6(net) || !Number.isInteger(bits) || bits < 0 || bits > 128) {
    return false;
  }
  const a = ipv6Bytes(ip);
  const b = ipv6Bytes(net);
  if (!a || !b) return false;
  for (let i = 0; i < 16; i++) {
    const used = Math.max(0, Math.min(8, bits - i * 8));
    if (used === 0) break;
    const mask = (0xff << (8 - used)) & 0xff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

function isLoopbackIp(ip: string): boolean {
  if (isIPv4(ip)) return ip.startsWith('127.');
  const groups = expandIpv6(ip);
  if (!groups) return false;
  return groups.join('') === '0'.repeat(31) + '1';
}

/** Hostname of a Host header value, port-stripped, lowercase, IPv6-literal aware. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.indexOf(':');
  return colon >= 0 ? h.slice(0, colon) : h;
}

// ---------------------------------------------------------------------------
// Network guard (contract §2.1) — socket address is the ONLY source of truth
// ---------------------------------------------------------------------------

export interface StudioRequestFacts {
  /** TCP socket remote address (already unwrapped from the transport). */
  socketRemoteAddress: string | null | undefined;
  /** Request headers, lower-cased keys. Never consulted for the allow decision. */
  headers: Record<string, string | undefined>;
}

export interface StudioDecision {
  allow: boolean;
  reason: string;
}

/**
 * Headers a real proxy sets and Next never synthesises on its own. Their
 * presence proves a proxy hop. (Next's base-server backfills
 * x-forwarded-host/x-forwarded-for/x-forwarded-proto/x-forwarded-port
 * itself on DIRECT connections — see the isDirectLocalConnection note.)
 */
const PROXY_ONLY_HEADERS = ['x-real-ip', 'forwarded'];

/**
 * Direct (non-nginx) connection on the loopback / trusted-proxy socket.
 *
 * Next backfills, for a request with NO client-supplied values:
 *   x-forwarded-for  = socket remote address   (base-server `??=`)
 *   x-forwarded-host = Host header             (base-server `??=`)
 * So a request is "direct" iff the (single) XFF hop normalises to the socket
 * address itself, X-Forwarded-Host equals Host, and no x-real-ip/forwarded
 * is present. Anything else on this socket arrived through the public proxy
 * (nginx sets XFF to the real public client via $proxy_add_x_forwarded_for),
 * which by contract is ALWAYS public — a client can put its own socket IP in
 * XFF, but that only matches trust it already has (loopback-local), and a
 * LAN/public claim or chain fails closed (kills the "allow loopback always"
 * and "trust leftmost hop" mutants, C5a/C5g/C5h).
 */
function isDirectLocalConnection(
  socketIp: string,
  headers: Record<string, string | undefined>,
): boolean {
  const xff = (headers['x-forwarded-for'] ?? '').trim();
  if (xff) {
    const hops = xff
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    if (hops.length !== 1) return false;
    if (normalizeSocketAddress(hops[0]) !== socketIp) return false;
  }
  if (PROXY_ONLY_HEADERS.some((h) => (headers[h] ?? '').trim().length > 0)) return false;
  const xfh = (headers['x-forwarded-host'] ?? '').trim();
  if (xfh) {
    const host = (headers['host'] ?? '').trim();
    if (xfh.toLowerCase() !== host.toLowerCase()) return false;
  }
  return true;
}

/**
 * The single guard decision (contract §2.1):
 *
 * 1. Start from the socket remote address; unmap IPv4-mapped IPv6. No usable
 *    socket address → DENY (fail closed).
 * 2. A public `Host` or a public nginx-set `X-Forwarded-Host` → DENY even if
 *    the socket looks local.
 * 3. Socket is the trusted public-proxy hop (loopback or MASTRA_STUDIO_TRUSTED_PROXY):
 *    any proxy signature header → DENY (public request via nginx; never
 *    recovered from forwarded addresses). No signature → a direct on-box
 *    connection (curl) → ALLOW.
 * 4. Else socket inside the configured LAN CIDRs or the Tailscale CGNAT range
 *    → ALLOW (headers are irrelevant to this decision).
 * 5. Else DENY.
 */
export function decideStudioAccess(
  facts: StudioRequestFacts,
  env: StudioEnv = process.env,
): StudioDecision {
  const ip = normalizeSocketAddress(facts.socketRemoteAddress);
  if (!ip) return { allow: false, reason: 'no-socket-address' };

  const publicHosts = studioPublicHosts(env);
  const host = facts.headers['host'];
  if (publicHosts.length > 0) {
    if (typeof host === 'string' && publicHosts.includes(hostnameOf(host))) {
      return { allow: false, reason: 'public-host' };
    }
    const xfh = facts.headers['x-forwarded-host'];
    if (typeof xfh === 'string' && publicHosts.includes(hostnameOf(xfh))) {
      return { allow: false, reason: 'public-forwarded-host' };
    }
  }

  const trusted = new Set<string>(studioTrustedProxies(env));
  if (isLoopbackIp(ip) || trusted.has(ip)) {
    if (!isDirectLocalConnection(ip, facts.headers)) {
      // Arrived through the public proxy hop. Public users arrive here too,
      // so this is ALWAYS public — no forwarded address may flip it back.
      return { allow: false, reason: 'via-trusted-proxy' };
    }
    return { allow: true, reason: 'direct-local' };
  }

  const cidrs = [...studioAllowedCidrs(env), TAILSCALE_CGNAT_IPV4_CIDR];
  if (cidrs.some((c) => ipInCidr(ip, c))) {
    return { allow: true, reason: 'allowlisted' };
  }
  return { allow: false, reason: 'not-allowlisted' };
}

// ---------------------------------------------------------------------------
// CORS — exact-origin allowlist, no wildcard, no reflection, no credentials
// ---------------------------------------------------------------------------

/** Canonical form of a CORS origin: scheme://host[:port], lowercase, no path. */
export function canonicalOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.pathname !== '/' || u.search !== '' || u.hash !== '') return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * MASTRA_STUDIO_ORIGIN (primary, e.g. the http://<internal-host-ip>:4111 Studio
 * origin) plus MASTRA_STUDIO_ALLOWED_ORIGINS (extra exact origins, e.g. the
 * Tailscale-addressed Studio origin). Malformed entries are dropped.
 */
export function studioCorsOrigins(env: StudioEnv = process.env): string[] {
  const list = [env.MASTRA_STUDIO_ORIGIN, ...splitList(env.MASTRA_STUDIO_ALLOWED_ORIGINS)]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0);
  const out: string[] = [];
  for (const entry of list) {
    const c = canonicalOrigin(entry);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Exact-match CORS decision for an actual request. Only an allowlisted origin
 * gets Access-Control-Allow-Origin (echoing the canonical allowlisted value,
 * never the raw header). Everything else — including `null`, prefix/suffix
 * look-alikes, scheme swaps, port typos and `*` — gets NO ACAO.
 * Credentials are never advertised (Studio is LAN/tailnet-only, cookie-free).
 */
export function studioCorsHeadersFor(
  requestOrigin: string | undefined | null,
  env: StudioEnv = process.env,
): Record<string, string> | null {
  if (!requestOrigin) return null;
  const candidate = canonicalOrigin(requestOrigin);
  if (!candidate) return null;
  const allowlist = studioCorsOrigins(env);
  if (!allowlist.includes(candidate)) return null;
  return {
    'access-control-allow-origin': candidate,
    vary: 'Origin',
  };
}

export const STUDIO_CORS_METHODS = 'GET, POST, OPTIONS';
export const STUDIO_CORS_REQUEST_HEADERS = 'content-type';

/** Preflight (OPTIONS) response headers, or null when the origin is not allowed. */
export function studioPreflightHeaders(
  requestOrigin: string | undefined | null,
  env: StudioEnv = process.env,
): Record<string, string> | null {
  const base = studioCorsHeadersFor(requestOrigin, env);
  if (!base) return null;
  return {
    ...base,
    'access-control-allow-methods': STUDIO_CORS_METHODS,
    'access-control-allow-headers': STUDIO_CORS_REQUEST_HEADERS,
    'access-control-max-age': '600',
  };
}

// ---------------------------------------------------------------------------
// Path allowlist (contract §2.2 + PM ruling C2f)
// ---------------------------------------------------------------------------

/** Agent ids are DB-generated; accept the conservative id charset only. */
const AGENT_ID_SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function segIsAgentId(seg: string | undefined): boolean {
  return typeof seg === 'string' && AGENT_ID_SEG.test(seg);
}

/**
 * The ONLY Studio API surfaces exposed when the flag is on (PM ruling: agents
 * list/detail/tools + generate + stream). Everything else under /api/mastra —
 * memory, tools, tools/execute, workflows, telemetry, stored workflows,
 * knowledge, vectors, datasets, experiments, scores, mcp, logs, v1/* — is 404
 * even with the flag on (C2f). `relPath` is the RAW (still percent-encoded)
 * path after the /api/mastra prefix; any percent-encoded form is rejected so a
 * decoded `%2F` can never re-shape the match (C4d defence-in-depth).
 */
export function isStudioApiPathAllowed(method: string, relPath: string): boolean {
  if (relPath.includes('%')) return false;
  if (relPath.includes('\\')) return false;
  const noTrail = relPath.endsWith('/') ? relPath.slice(0, -1) : relPath;
  if (noTrail.includes('//')) return false;
  const segs = noTrail === '' ? [] : noTrail.split('/');
  const m = method.toUpperCase();
  // OPTIONS (preflight) rides the shape of its target endpoint.
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
    if (segs.length === 1 && segs[0] === 'agents') return true;
    if (segs.length === 2 && segs[0] === 'agents' && segIsAgentId(segs[1])) return true;
    if (
      segs.length === 3 &&
      segs[0] === 'agents' &&
      segIsAgentId(segs[1]) &&
      segs[2] === 'tools'
    ) {
      return true;
    }
    return false;
  }
  if (m === 'POST') {
    if (
      segs.length === 3 &&
      segs[0] === 'agents' &&
      segIsAgentId(segs[1]) &&
      (segs[2] === 'generate' || segs[2] === 'stream')
    ) {
      return true;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auth: Studio has NO auth layer (final product ruling). The network guard
// above — socket remote address in the LAN/tailnet allowlist — is the only
// access control. Requests that reach this point are trusted LAN peers.
// ---------------------------------------------------------------------------
