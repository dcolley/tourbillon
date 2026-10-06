import { promises as dns } from 'node:dns';

export const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8',
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
] as const;

/** @deprecated Use METADATA_NEVER_IPV4_CIDR — the never-list is the whole /16. */
export const CLOUD_METADATA_IPV4 = '169.254.169.254';

export const METADATA_NEVER_IPV4_CIDR = '169.254.0.0/16';
export const METADATA_NEVER_LINK_LOCAL_CIDR = 'fe80::/10';
export const METADATA_NEVER_AWS_IPV6 = 'fd00:ec2::254';
export const METADATA_NEVER_ALIBABA_IPV4 = '100.100.100.200';
export const METADATA_NEVER_HOSTNAMES = ['metadata.google.internal', 'metadata'] as const;

export const LOOPBACK_IPV4_CIDR = '127.0.0.0/8';

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type HostResolver = (host: string) => Promise<ResolvedAddress[]>;

export type EgressDenyReason =
  | 'not_on_allow_list'
  | 'private_range'
  | 'cloud_metadata'
  | 'dns_failed';

export type EgressDecision =
  | { allowed: true; pin: ResolvedAddress; checked: ResolvedAddress[] }
  | { allowed: false; status: 403 | 502; reason: EgressDenyReason; detail: string };

export function parseHostPort(target: string): { host: string; port?: number } {
  const trimmed = target.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return { host: trimmed };
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    if (rest.startsWith(':')) {
      const port = parseInt(rest.slice(1), 10);
      return { host, port: Number.isFinite(port) ? port : undefined };
    }
    return { host };
  }
  /* Unbracketed IPv6 has 2+ colons; host:port for IPv6 must use [addr]:port. */
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount > 1) {
    return { host: trimmed };
  }
  const idx = trimmed.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(trimmed.slice(idx + 1))) {
    return { host: trimmed.slice(0, idx), port: parseInt(trimmed.slice(idx + 1), 10) };
  }
  return { host: trimmed };
}

export function isIpv4Address(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

/**
 * Whether a hostname or IP is in the allow-list.
 * Entries: exact host, IP, `*.example.com`, or CIDR.
 */
export function isHostAllowed(host: string, allowList: string[]): boolean {
  if (allowList.length === 0) return false;
  const hostWithoutPort = parseHostPort(host).host.replace(/^\[|\]$/g, '').toLowerCase();

  const hostCanon = canonicalIp(hostWithoutPort);

  for (const raw of allowList) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === hostWithoutPort) return true;
    if (hostCanon && canonicalIp(entry) === hostCanon) return true;
    if (entry.startsWith('*.')) {
      const domain = entry.slice(2);
      if (hostWithoutPort.endsWith(`.${domain}`)) return true;
    }
    if (entry.includes('/')) {
      const ipForCidr = effectiveIpv4(hostWithoutPort) ?? hostWithoutPort;
      if (isIpv4Address(ipForCidr) && matchesIpv4Cidr(ipForCidr, entry)) return true;
      if (parseIpv6Bytes(hostWithoutPort) && matchesIpv6Cidr(hostWithoutPort, entry)) return true;
    }
  }
  return false;
}

function parseHexGroup(group: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
  return parseInt(group, 16);
}

/** Expand IPv6 (including dotted IPv4 tail) to 16 bytes, or null. */
export function parseIpv6Bytes(ip: string): Uint8Array | null {
  let value = ip.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  if (!value.includes(':')) return null;

  let head = value;
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIpv4Address(tail)) return null;
    const octets = tail.split('.').map(Number);
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    head = `${value.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const sides = head.split('::');
  if (sides.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const groups = side.split(':');
    const out: number[] = [];
    for (const group of groups) {
      const n = parseHexGroup(group);
      if (n === null) return null;
      out.push(n);
    }
    return out;
  };

  let groups: number[];
  if (sides.length === 2) {
    const left = parseSide(sides[0]!);
    const right = parseSide(sides[1]!);
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill(0), ...right];
  } else {
    const parsed = parseSide(sides[0]!);
    if (!parsed || parsed.length !== 8) return null;
    groups = parsed;
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i]! >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  return bytes;
}

export function isIpv6Address(value: string): boolean {
  return parseIpv6Bytes(value) !== null;
}

function ipv4ToInt(ip: string): number | null {
  if (!isIpv4Address(ip)) return null;
  return ip.split('.').reduce((acc, octet) => (acc << 8) | Number(octet), 0) >>> 0;
}

export function matchesIpv4Cidr(ip: string, cidr: string): boolean {
  const ipInt = ipv4ToInt(ip);
  const slash = cidr.indexOf('/');
  if (ipInt === null || slash === -1) return false;
  const network = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  const netInt = ipv4ToInt(network);
  if (netInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

export function matchesIpv6Cidr(ip: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf('/');
  if (slash === -1) return false;
  const network = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  const ipBytes = parseIpv6Bytes(ip);
  const netBytes = parseIpv6Bytes(network);
  if (!ipBytes || !netBytes || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
    return false;
  }
  const fullBytes = Math.floor(prefix / 8);
  const rem = prefix % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== netBytes[i]) return false;
  }
  if (rem) {
    const mask = (0xff << (8 - rem)) & 0xff;
    if ((ipBytes[fullBytes]! & mask) !== (netBytes[fullBytes]! & mask)) return false;
  }
  return true;
}

/** IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:aabb:ccdd) → IPv4, else null. */
export function unwrapIpv4Mapped(ip: string): string | null {
  const bytes = parseIpv6Bytes(ip);
  if (!bytes) return null;
  const mapped =
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 0 &&
    bytes[4] === 0 &&
    bytes[5] === 0 &&
    bytes[6] === 0 &&
    bytes[7] === 0 &&
    bytes[8] === 0 &&
    bytes[9] === 0 &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (!mapped) return null;
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

export function canonicalIp(ip: string): string | null {
  const trimmed = ip.trim();
  if (isIpv4Address(trimmed)) return `v4:${trimmed}`;
  const mapped = unwrapIpv4Mapped(trimmed);
  if (mapped) return `v4:${mapped}`;
  const bytes = parseIpv6Bytes(trimmed);
  if (!bytes) return null;
  return `v6:${Buffer.from(bytes).toString('hex')}`;
}

export function effectiveIpv4(ip: string): string | null {
  if (isIpv4Address(ip)) return ip;
  return unwrapIpv4Mapped(ip);
}

/**
 * Cloud metadata destinations that are never allowed, even when listed.
 * Exactly: 169.254.0.0/16, fe80::/10, fd00:ec2::254, 100.100.100.200
 * (plus IPv4-mapped forms of the IPv4 entries).
 */
export function isCloudMetadataIp(ip: string): boolean {
  const v4 = effectiveIpv4(ip);
  if (v4) {
    if (matchesIpv4Cidr(v4, METADATA_NEVER_IPV4_CIDR)) return true;
    if (v4 === METADATA_NEVER_ALIBABA_IPV4) return true;
    return false;
  }
  if (matchesIpv6Cidr(ip, METADATA_NEVER_LINK_LOCAL_CIDR)) return true;
  if (canonicalIp(ip) === canonicalIp(METADATA_NEVER_AWS_IPV6)) return true;
  return false;
}

export function isCloudMetadataHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (METADATA_NEVER_HOSTNAMES as readonly string[]).includes(normalized);
}

export function isIpv6Unspecified(ip: string): boolean {
  const bytes = parseIpv6Bytes(ip);
  return !!bytes && bytes.every((b) => b === 0);
}

export function isIpv6Loopback(ip: string): boolean {
  const bytes = parseIpv6Bytes(ip);
  if (!bytes) return false;
  return bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
}

export function isLoopbackIp(ip: string): boolean {
  const v4 = effectiveIpv4(ip);
  if (v4) return matchesIpv4Cidr(v4, LOOPBACK_IPV4_CIDR);
  return isIpv6Loopback(ip);
}

export function isBlockedPrivateRange(ip: string): boolean {
  const v4 = effectiveIpv4(ip);
  if (v4) {
    return BLOCKED_IPV4_CIDRS.some((cidr) => matchesIpv4Cidr(v4, cidr));
  }
  if (isIpv6Unspecified(ip) || isIpv6Loopback(ip)) return true;
  if (matchesIpv6Cidr(ip, 'fc00::/7')) return true;
  if (matchesIpv6Cidr(ip, 'fe80::/10')) return true;
  return false;
}

function normalizeHost(host: string): string {
  return parseHostPort(host).host.replace(/^\[|\]$/g, '').toLowerCase();
}

function parseAllowListEntry(raw: string): {
  kind: 'wildcard' | 'cidr' | 'ip' | 'host';
  value: string;
  prefix?: number;
} | null {
  const entry = raw.trim().toLowerCase();
  if (!entry) return null;
  if (entry.startsWith('*.')) {
    return { kind: 'wildcard', value: entry };
  }
  const slash = entry.lastIndexOf('/');
  if (slash !== -1) {
    const addr = entry.slice(0, slash);
    const prefix = Number(entry.slice(slash + 1));
    if (isIpv4Address(addr) && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
      return { kind: 'cidr', value: addr, prefix };
    }
    if (parseIpv6Bytes(addr) && Number.isInteger(prefix) && prefix >= 0 && prefix <= 128) {
      return { kind: 'cidr', value: addr, prefix };
    }
    return null;
  }
  if (isIpv4Address(entry) || parseIpv6Bytes(entry)) {
    return { kind: 'ip', value: entry };
  }
  return { kind: 'host', value: entry };
}

function cidrContainsIp(ip: string, network: string, prefix: number): boolean {
  const v4 = effectiveIpv4(ip);
  const netV4 = effectiveIpv4(network);
  if (v4 && netV4) return matchesIpv4Cidr(v4, `${netV4}/${prefix}`);
  if (!v4 && !netV4) return matchesIpv6Cidr(ip, `${network}/${prefix}`);
  return false;
}

/**
 * Whether a blocked-range destination may be reached via an explicit list entry.
 * Wildcards never apply. Metadata is never allowed. Loopback only via exact IP
 * (or a /32 or /128 of that exact address) — never a wider CIDR, never a hostname.
 */
export function hasPrivateOverride(ip: string, host: string, allowList: string[]): boolean {
  if (isCloudMetadataIp(ip) || isCloudMetadataHost(host)) return false;

  const hostNorm = normalizeHost(host);
  const loopback = isLoopbackIp(ip);

  for (const raw of allowList) {
    const parsed = parseAllowListEntry(raw);
    if (!parsed || parsed.kind === 'wildcard') continue;

    if (parsed.kind === 'ip') {
      if (canonicalIp(parsed.value) === canonicalIp(ip)) return true;
      continue;
    }

    if (parsed.kind === 'cidr') {
      const prefix = parsed.prefix ?? -1;
      const exactPrefix = effectiveIpv4(parsed.value) ? 32 : 128;
      if (loopback && prefix !== exactPrefix) continue;
      if (loopback && canonicalIp(parsed.value) !== canonicalIp(ip)) continue;
      if (cidrContainsIp(ip, parsed.value, prefix)) return true;
      continue;
    }

    if (loopback) continue;
    if (parsed.kind === 'host' && parsed.value === hostNorm) return true;
  }

  return false;
}

export async function defaultHostResolver(host: string): Promise<ResolvedAddress[]> {
  const literal = ipLiteral(host);
  if (literal) return [literal];
  const records = await dns.lookup(host, { all: true, verbatim: true });
  return records.map((row) => ({
    address: row.address,
    family: row.family === 6 ? 6 : 4,
  }));
}

export function ipLiteral(host: string): ResolvedAddress | null {
  const trimmed = host.trim().replace(/^\[|\]$/g, '');
  if (isIpv4Address(trimmed)) return { address: trimmed, family: 4 };
  if (parseIpv6Bytes(trimmed)) {
    const mapped = unwrapIpv4Mapped(trimmed);
    if (mapped) return { address: mapped, family: 4 };
    return { address: trimmed, family: 6 };
  }
  return null;
}

function pinChecked(rec: ResolvedAddress): ResolvedAddress {
  const mapped = unwrapIpv4Mapped(rec.address);
  if (mapped) return { address: mapped, family: 4 };
  return rec;
}

/** Exact host or `*.domain` only — IP/CIDR entries do not count as a hostname match. */
export function isHostnameListed(host: string, allowList: string[]): boolean {
  const normalized = normalizeHost(host);
  if (!normalized || ipLiteral(normalized)) return false;
  for (const raw of allowList) {
    const parsed = parseAllowListEntry(raw);
    if (!parsed) continue;
    if (parsed.kind === 'host' && parsed.value === normalized) return true;
    if (parsed.kind === 'wildcard') {
      const domain = parsed.value.slice(2);
      if (domain && normalized.endsWith(`.${domain}`)) return true;
    }
  }
  return false;
}

function denyNotOnAllowList(host: string): EgressDecision {
  return {
    allowed: false,
    status: 403,
    reason: 'not_on_allow_list',
    detail: `Forbidden: Host '${host}' is not in the egress allow-list`,
  };
}

function denyMetadata(): EgressDecision {
  return {
    allowed: false,
    status: 403,
    reason: 'cloud_metadata',
    detail: 'Forbidden: Cloud metadata address is not allowed',
  };
}

function checkResolvedAddresses(
  host: string,
  resolved: ResolvedAddress[],
  allowList: string[],
  publicInternet: boolean,
): EgressDecision {
  for (const rec of resolved) {
    const ip = rec.address;
    if (isCloudMetadataIp(ip)) return denyMetadata();
    if (isBlockedPrivateRange(ip)) {
      if (publicInternet || !hasPrivateOverride(ip, host, allowList)) {
        return {
          allowed: false,
          status: 403,
          reason: 'private_range',
          detail: `Forbidden: Host '${host}' resolves to a blocked private range`,
        };
      }
    }
  }
  return {
    allowed: true,
    pin: pinChecked(resolved[0]!),
    checked: resolved.map(pinChecked),
  };
}

export async function authorizeEgressTarget(options: {
  host: string;
  allowList: string[];
  publicInternet?: boolean;
  resolve?: HostResolver;
}): Promise<EgressDecision> {
  const host = normalizeHost(options.host);
  const allowList = options.allowList;
  const publicInternet = options.publicInternet === true;
  const resolve = options.resolve ?? defaultHostResolver;

  if (!host) {
    return {
      allowed: false,
      status: 403,
      reason: 'not_on_allow_list',
      detail: 'Forbidden: missing host',
    };
  }

  if (isCloudMetadataHost(host)) {
    return denyMetadata();
  }

  const literal = ipLiteral(host);
  if (literal) {
    if (!publicInternet && !isHostAllowed(host, allowList)) {
      return denyNotOnAllowList(host);
    }
    return checkResolvedAddresses(host, [literal], allowList, publicInternet);
  }

  if (!publicInternet) {
    if (!isHostnameListed(host, allowList)) {
      return denyNotOnAllowList(host);
    }
  }

  let resolved: ResolvedAddress[];
  try {
    resolved = await resolve(host);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      allowed: false,
      status: 502,
      reason: 'dns_failed',
      detail: `Bad Gateway: failed to resolve '${host}': ${message}`,
    };
  }

  if (!resolved.length) {
    return {
      allowed: false,
      status: 502,
      reason: 'dns_failed',
      detail: `Bad Gateway: failed to resolve '${host}'`,
    };
  }

  return checkResolvedAddresses(host, resolved, allowList, publicInternet);
}
