/**
 * Egress policy for the `browser` toolset.
 *
 * Every URL the browser is asked to load (agent navigation, page subresources,
 * redirect hops on navigations, WebSockets) goes through {@link checkBrowserUrl}:
 *
 * 1. Scheme: only http(s). Navigation may also target exactly `about:blank`.
 *    file:, data:, javascript:, chrome:, view-source:, blob:, ftp:, ws: … are refused.
 *    URLs with user info are refused.
 * 2. Outbound host allow-list (company and agent `toolEgressAllowList`, same stored
 *    fields and match rules as the tool egress allow-list in #141). Unset = no host
 *    restriction. Set = the host must match every list that is set; an empty or
 *    unreadable list allows nothing.
 * 3. Network policy: local and internal destinations are always refused, whatever the
 *    lists say — loopback, RFC1918, CGNAT, link-local / cloud metadata (169.254.0.0/16,
 *    fe80::/10, fd00:ec2::254, 100.100.100.200, metadata hostnames), unique-local IPv6,
 *    unspecified. Hostnames are resolved and every address is checked.
 */
import {
  authorizeEgressTarget,
  defaultHostResolver,
  type HostResolver,
} from '../egress-private-ranges';

export type BrowserEgressDenyReason =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_in_url'
  | 'not_on_allow_list'
  | 'private_range'
  | 'cloud_metadata'
  | 'dns_failed'
  | 'too_many_redirects';

export type BrowserEgressDecision =
  | { allowed: true; host: string | null }
  | { allowed: false; reason: BrowserEgressDenyReason; host: string | null };

/** Raw stored lists; `undefined` = that level does not restrict. */
export interface BrowserHostAllowList {
  company?: string[];
  agent?: string[];
}

export interface BrowserEgressPolicy {
  hostAllowList: BrowserHostAllowList;
  resolve?: HostResolver;
}

/**
 * Read the stored outbound host lists. A non-array value that is set (corrupt JSON)
 * still restricts: it becomes an empty list, which allows nothing.
 */
export function readBrowserHostAllowList(
  companySettings: unknown,
  agentRuntimeConfig: unknown,
): BrowserHostAllowList {
  const read = (holder: unknown): string[] | undefined => {
    if (!holder || typeof holder !== 'object') return undefined;
    const raw = (holder as { toolEgressAllowList?: unknown }).toolEgressAllowList;
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is string => typeof item === 'string');
  };
  const out: BrowserHostAllowList = {};
  const company = read(companySettings);
  const agent = read(agentRuntimeConfig);
  if (company) out.company = company;
  if (agent) out.agent = agent;
  return out;
}

export function isBrowserHostAllowListRestricted(list: BrowserHostAllowList): boolean {
  return list.company !== undefined || list.agent !== undefined;
}

const IPV4_DOTTED = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_LABELS = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

interface ParsedEntry {
  kind: 'host' | 'wildcard' | 'ipv4';
  host: string;
  port: number | null;
}

/** Entry forms: `host`, `*.domain` (subdomains only), dotted IPv4; optional `:port`. */
export function parseBrowserHostEntry(raw: string): ParsedEntry | null {
  let entry = raw.trim().toLowerCase();
  if (!entry || entry.includes('/') || entry.includes('@') || entry.startsWith('[')) return null;
  let port: number | null = null;
  const colon = entry.lastIndexOf(':');
  if (colon !== -1) {
    const p = entry.slice(colon + 1);
    if (!/^\d{1,5}$/.test(p)) return null;
    port = Number(p);
    if (port < 1 || port > 65535) return null;
    entry = entry.slice(0, colon);
  }
  if (entry.startsWith('*.')) {
    const domain = entry.slice(2);
    if (!HOST_LABELS.test(domain) || IPV4_DOTTED.test(domain)) return null;
    return { kind: 'wildcard', host: domain, port };
  }
  if (IPV4_DOTTED.test(entry)) return { kind: 'ipv4', host: entry, port };
  if (/^[\d.]+$/.test(entry)) return null;
  if (!HOST_LABELS.test(entry)) return null;
  return { kind: 'host', host: entry, port };
}

function entryMatches(entry: ParsedEntry, host: string, port: number, isIpv4: boolean): boolean {
  if (entry.port !== null && entry.port !== port) return false;
  if (entry.kind === 'ipv4') return isIpv4 && host === entry.host;
  if (isIpv4) return false;
  if (entry.kind === 'host') return host === entry.host;
  return host.length > entry.host.length + 1 && host.endsWith(`.${entry.host}`);
}

/** Host-list decision only (no scheme / network checks). */
export function isHostOnBrowserAllowList(
  list: BrowserHostAllowList,
  host: string,
  port: number,
): boolean {
  if (!isBrowserHostAllowListRestricted(list)) return true;
  const h = host.toLowerCase();
  if (h.startsWith('[') || h.includes(':')) return false; // IPv6 literal: refused while a list is set
  const isIpv4 = IPV4_DOTTED.test(h);
  for (const level of [list.company, list.agent]) {
    if (level === undefined) continue;
    const ok = level.some((raw) => {
      const parsed = parseBrowserHostEntry(raw);
      return parsed !== null && entryMatches(parsed, h, port, isIpv4);
    });
    if (!ok) return false;
  }
  return true;
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

/** Host only, for logs and tool errors — never a path, query or user info. */
function safeHost(url: URL | null): string | null {
  if (!url) return null;
  return url.hostname ? url.hostname.slice(0, 253) : null;
}

export function isAboutBlank(url: string): boolean {
  return url.trim().toLowerCase() === 'about:blank';
}

export async function checkBrowserUrl(
  rawUrl: string,
  policy: BrowserEgressPolicy,
  options?: { navigation?: boolean },
): Promise<BrowserEgressDecision> {
  if (options?.navigation && isAboutBlank(rawUrl)) return { allowed: true, host: null };

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { allowed: false, reason: 'invalid_url', host: null };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: 'scheme_not_allowed', host: safeHost(url) };
  }
  if (url.username || url.password) {
    return { allowed: false, reason: 'credentials_in_url', host: safeHost(url) };
  }
  const host = url.hostname.toLowerCase();
  if (!host) return { allowed: false, reason: 'invalid_url', host: null };
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol]!;

  if (!isHostOnBrowserAllowList(policy.hostAllowList, host, port)) {
    return { allowed: false, reason: 'not_on_allow_list', host };
  }

  const network = await authorizeEgressTarget({
    host,
    allowList: [],
    // No list-based override of private ranges: local/internal is always refused.
    publicInternet: true,
    resolve: policy.resolve ?? defaultHostResolver,
  });
  if (!network.allowed) {
    const reason: BrowserEgressDenyReason =
      network.reason === 'cloud_metadata'
        ? 'cloud_metadata'
        : network.reason === 'dns_failed'
          ? 'dns_failed'
          : 'private_range';
    return { allowed: false, reason, host };
  }
  return { allowed: true, host };
}

export function describeBrowserEgressDenial(decision: Extract<BrowserEgressDecision, { allowed: false }>): string {
  const target = decision.host ? `'${decision.host}'` : 'this URL';
  switch (decision.reason) {
    case 'scheme_not_allowed':
      return 'Only http and https URLs can be opened in the browser.';
    case 'credentials_in_url':
      return 'URLs with a username or password cannot be opened in the browser.';
    case 'invalid_url':
      return 'The URL could not be parsed.';
    case 'not_on_allow_list':
      return `Host ${target} is not on the outbound host allow-list for this agent.`;
    case 'cloud_metadata':
      return 'Cloud metadata addresses cannot be opened in the browser.';
    case 'private_range':
      return `Host ${target} is a local or internal address and cannot be opened in the browser.`;
    case 'dns_failed':
      return `Host ${target} could not be resolved.`;
    case 'too_many_redirects':
      return 'The page redirected too many times.';
    default:
      return `Host ${target} is not allowed.`;
  }
}
