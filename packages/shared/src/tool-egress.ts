/**
 * Tool-host allow-list for agent tools (outbound hosts, matched by host name).
 *
 * A company (`settings.toolEgressAllowList`) and an agent (`runtimeConfig.toolEgressAllowList`)
 * may each set a list of hosts that agent tools may contact (web search, Nitter, HTTP MCP
 * servers). Neither set → every host is allowed (default). When one or both are set, a host must
 * match every list that is set, so an agent list can only narrow the company list.
 *
 * Entries: an exact host (`search.example.com`), a leading wildcard for subdomains only
 * (`*.example.com` does not match `example.com`), or an IPv4 address in dotted-decimal form,
 * each with an optional `:port` (no port = any port). Hosts are matched case-insensitively
 * after IDN → punycode normalisation. A wildcard may not cover a whole public suffix (public
 * suffix list, including its private section, e.g. `*.com`, `*.co.uk`, `*.github.io`), a
 * single-label name, or `localhost`; exact hosts, including internal names and IPv4
 * addresses, are allowed.
 *
 * Matching is by the host name in the URL only, with no DNS resolution: a listed name may
 * resolve to any address. This is a tool-host allow-list, not an internal-network or DNS guard.
 *
 * Destinations are refused when a list is set and the URL carries user info, uses a non-http(s)
 * scheme, an IPv6 literal (including IPv4-mapped forms), an IPv4 literal in any form other than
 * dotted decimal (single number, octal, hex, short forms), a trailing-dot host or a
 * percent-encoded host. Redirects are followed by hand and every hop is checked
 * ({@link fetchWithToolEgress}).
 *
 * Pure (WHATWG URL only), apart from the fetch helper.
 */
import type { AgentRuntimeConfig, CompanySettings } from './types';
import { readStoredToolEgressAllowList, resolveSearxngBaseUrl } from './company-settings';
import { parse as parseDomain } from 'tldts';
import { SEARXNG_TOOLSET_TOOL_IDS, TAVILY_TOOLSET_TOOL_IDS, NITTER_TOOLSET_TOOL_IDS, toolKeyForId } from './tool-permissions';

export const TOOL_EGRESS_MAX_ENTRIES = 200;
/** Raw entries accepted per save before de-duplication (bounds work on oversized input). */
export const TOOL_EGRESS_MAX_RAW_ENTRIES = 1000;
export const TOOL_EGRESS_MAX_REDIRECTS = 5;
export const TAVILY_API_ORIGIN = 'https://api.tavily.com';

export const TOOL_EGRESS_ALLOW_LIST_HELP = [
  'One host per line: search.example.com, *.example.com (subdomains only) or an IPv4 address',
  'Wildcards cannot cover a whole public suffix (*.com, *.co.uk) or localhost; list exact hosts instead',
  'Add :port to allow only that port; without a port every port is allowed',
  'Leave the list off to allow every host (default)',
  'Matched by host name only, without DNS lookups: a listed name may resolve to any address, so this is not an internal-network or DNS guard',
  'Not enforced for local (stdio) MCP servers',
] as const;

/** Refused allow-list input on save (bad mode, list shape or entry). The message names the problem. */
export class ToolEgressAllowListValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolEgressAllowListValidationError';
  }
}

export function isToolEgressAllowListValidationError(err: unknown): err is ToolEgressAllowListValidationError {
  return (
    err instanceof ToolEgressAllowListValidationError ||
    (err instanceof Error && err.name === 'ToolEgressAllowListValidationError')
  );
}

export type ToolEgressEntryKind = 'host' | 'wildcard' | 'ipv4';

export interface ToolEgressEntry {
  kind: ToolEgressEntryKind;
  /** Lowercase ASCII (punycode) host; for wildcards, the domain after `*.`. */
  host: string;
  /** null = any port. */
  port: number | null;
}

export type ToolEgressEntryParseResult =
  | { ok: true; entry: string; parsed: ToolEgressEntry }
  | { ok: false; error: string };

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_LIKE_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/i;

function isCanonicalIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
}

/** True when the WHATWG URL parser would read this host as an IPv4 address (any notation). */
function looksLikeIpv4Literal(host: string): boolean {
  const labels = host.split('.');
  if (labels.length > 0 && labels[labels.length - 1] === '') labels.pop();
  if (labels.length === 0) return false;
  return IPV4_LIKE_LABEL.test(labels[labels.length - 1]!);
}

/** Lowercase ASCII form of a hostname (IDN → punycode), or null when it is not a valid hostname. */
function toAsciiHostname(host: string): string | null {
  let ascii: string;
  try {
    ascii = new URL(`http://${host}/`).hostname;
  } catch {
    return null;
  }
  if (!ascii || ascii.length > 253) return null;
  if (!ascii.split('.').every((label) => HOSTNAME_LABEL.test(label))) return null;
  return ascii;
}

function parsePort(raw: string): number | null | 'invalid' {
  if (!/^[0-9]{1,5}$/.test(raw)) return 'invalid';
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : 'invalid';
}

/**
 * Why a wildcard base is refused, or null when it is a registrable domain (or below one).
 * Refused: localhost and names under it, single-label names, and any name that is itself a
 * public suffix or sits inside one (public suffix list, ICANN and private sections).
 */
function wildcardBaseError(domain: string): string | null {
  if (domain === 'localhost' || domain.endsWith('.localhost')) {
    return 'Wildcards under localhost are not allowed; list the exact host.';
  }
  const info = parseDomain(domain, { allowPrivateDomains: true });
  if (!domain.includes('.') || info.publicSuffix === domain || info.domain === null) {
    return 'A wildcard cannot cover a whole public suffix (e.g. *.com, *.co.uk); use *.yourdomain.example or exact hosts.';
  }
  return null;
}

/** Validate and normalise one allow-list entry. */
export function parseToolEgressEntry(raw: string): ToolEgressEntryParseResult {
  const entry = typeof raw === 'string' ? raw.trim() : '';
  if (!entry) return { ok: false, error: 'Entry is empty.' };
  if (/\s/.test(entry)) return { ok: false, error: 'Whitespace is not allowed inside an entry.' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) || entry.startsWith('//')) {
    return { ok: false, error: 'Enter a host, not a URL.' };
  }
  if (entry.includes('@')) return { ok: false, error: 'User info (name@host) is not allowed.' };
  if (/[/?#\\]/.test(entry)) return { ok: false, error: 'Paths are not allowed; enter a host only.' };
  if (entry.includes('%')) return { ok: false, error: 'Percent-encoded hosts are not allowed.' };
  if (entry.startsWith('[') || (entry.match(/:/g) ?? []).length > 1) {
    return { ok: false, error: 'IPv6 addresses are not supported.' };
  }

  let hostPart = entry;
  let port: number | null = null;
  const colon = entry.lastIndexOf(':');
  if (colon !== -1) {
    hostPart = entry.slice(0, colon);
    const p = parsePort(entry.slice(colon + 1));
    if (p === 'invalid') return { ok: false, error: 'Port must be a number from 1 to 65535.' };
    port = p;
  }
  const portSuffix = port === null ? '' : `:${port}`;
  const lower = hostPart.toLowerCase();
  if (!lower) return { ok: false, error: 'Entry is empty.' };
  if (lower.endsWith('.')) return { ok: false, error: 'Remove the trailing dot.' };
  if (lower === '*') return { ok: false, error: 'Bare * is not allowed; leave the list off to allow every host.' };

  if (lower.startsWith('*.')) {
    const domain = lower.slice(2);
    if (domain.includes('*')) return { ok: false, error: 'Only one leading *. is allowed.' };
    if (looksLikeIpv4Literal(domain)) return { ok: false, error: 'Wildcards cannot be used with IP addresses.' };
    const ascii = toAsciiHostname(domain);
    if (!ascii) return { ok: false, error: 'Enter a wildcard as *.domain (subdomains only).' };
    const baseError = wildcardBaseError(ascii);
    if (baseError) return { ok: false, error: baseError };
    return { ok: true, entry: `*.${ascii}${portSuffix}`, parsed: { kind: 'wildcard', host: ascii, port } };
  }
  if (lower.includes('*')) return { ok: false, error: 'A wildcard is only allowed as a leading *.' };

  if (looksLikeIpv4Literal(lower)) {
    if (!isCanonicalIpv4(lower)) {
      return { ok: false, error: 'Write an IPv4 address as four decimal numbers, e.g. 203.0.113.7.' };
    }
    return { ok: true, entry: `${lower}${portSuffix}`, parsed: { kind: 'ipv4', host: lower, port } };
  }

  const ascii = toAsciiHostname(lower);
  if (!ascii) return { ok: false, error: 'Enter a host name, *.domain or an IPv4 address.' };
  return { ok: true, entry: `${ascii}${portSuffix}`, parsed: { kind: 'host', host: ascii, port } };
}

/**
 * Validate a list for saving: canonical entries, de-duplicated. Throws
 * {@link ToolEgressAllowListValidationError} naming the bad entry or shape.
 */
export function sanitizeToolEgressAllowList(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    throw new ToolEgressAllowListValidationError('The allow-list must be a list of hosts.');
  }
  if (entries.length > TOOL_EGRESS_MAX_RAW_ENTRIES) {
    throw new ToolEgressAllowListValidationError(`At most ${TOOL_EGRESS_MAX_ENTRIES} entries are allowed.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of entries) {
    if (typeof raw !== 'string') {
      throw new ToolEgressAllowListValidationError('Each allow-list entry must be a string.');
    }
    const parsed = parseToolEgressEntry(raw);
    if (!parsed.ok) {
      throw new ToolEgressAllowListValidationError(`${raw.trim().slice(0, 100) || '(empty)'}: ${parsed.error}`);
    }
    if (seen.has(parsed.entry)) continue;
    seen.add(parsed.entry);
    out.push(parsed.entry);
  }
  if (out.length > TOOL_EGRESS_MAX_ENTRIES) {
    throw new ToolEgressAllowListValidationError(`At most ${TOOL_EGRESS_MAX_ENTRIES} entries are allowed.`);
  }
  return out;
}

export type ToolEgressMode = 'off' | 'list';

/**
 * Form/API input → stored value, validated on every write. `null` = off (allow every host);
 * an array (even empty) = list. The mode must be given explicitly ('off' or 'list'), so a
 * missing field never clears a list. Throws {@link ToolEgressAllowListValidationError}.
 */
export function resolveToolEgressAllowListInput(mode: unknown, entries: unknown): string[] | null {
  if (mode === 'off') {
    if (entries !== undefined && entries !== null && !Array.isArray(entries)) {
      throw new ToolEgressAllowListValidationError('The allow-list must be a list of hosts.');
    }
    return null;
  }
  if (mode !== 'list') throw new ToolEgressAllowListValidationError("Mode must be 'off' or 'list'.");
  return sanitizeToolEgressAllowList(entries);
}

/** Split a textarea value (newlines or commas) into raw entries. */
export function splitToolEgressAllowListText(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ToolEgressPolicy {
  /** undefined = not set (no restriction from this level). */
  company?: ToolEgressEntry[];
  agent?: ToolEgressEntry[];
}

function parseStoredEntries(list: string[] | undefined): ToolEgressEntry[] | undefined {
  if (list === undefined) return undefined;
  const out: ToolEgressEntry[] = [];
  for (const raw of list) {
    const parsed = parseToolEgressEntry(raw);
    // An unreadable stored entry matches nothing; the list still restricts.
    if (parsed.ok) out.push(parsed.parsed);
  }
  return out;
}

export function resolveToolEgressPolicy(
  companySettings?: Pick<CompanySettings, 'toolEgressAllowList'> | null,
  agentRuntime?: Pick<AgentRuntimeConfig, 'toolEgressAllowList'> | null,
): ToolEgressPolicy {
  const policy: ToolEgressPolicy = {};
  const company = parseStoredEntries(readStoredToolEgressAllowList(companySettings?.toolEgressAllowList));
  const agent = parseStoredEntries(readStoredToolEgressAllowList(agentRuntime?.toolEgressAllowList));
  if (company) policy.company = company;
  if (agent) policy.agent = agent;
  return policy;
}

/**
 * True when a stored list value (raw JSON, before parsing) is set but not a list of valid
 * entries: not an array, a non-string item, or an entry that does not parse. Such a value
 * stays restrictive (unreadable entries match no host); this only drives a diagnostic.
 */
export function isStoredToolEgressAllowListMalformed(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (!Array.isArray(raw)) return true;
  return raw.some((item) => typeof item !== 'string' || !parseToolEgressEntry(item).ok);
}

/**
 * One diagnostic line when a stored company or agent list is malformed, naming only the ids;
 * null when both are fine. Never includes the stored entries.
 */
export function malformedToolEgressAllowListWarning(input: {
  companyId?: string | null;
  companyList?: unknown;
  agentId?: string | null;
  agentList?: unknown;
}): string | null {
  const parts: string[] = [];
  if (input.companyId && isStoredToolEgressAllowListMalformed(input.companyList)) parts.push(`company ${input.companyId}`);
  if (input.agentId && isStoredToolEgressAllowListMalformed(input.agentList)) parts.push(`agent ${input.agentId}`);
  if (parts.length === 0) return null;
  return `[tool-egress] malformed outbound host allow-list for ${parts.join(', ')}; unreadable entries match no host until the list is saved again`;
}

export function isToolEgressRestricted(policy: ToolEgressPolicy | null | undefined): boolean {
  return Boolean(policy && (policy.company !== undefined || policy.agent !== undefined));
}

/** Stable short key for a policy ('' when unrestricted), e.g. for client caches. */
export function toolEgressPolicyKey(policy: ToolEgressPolicy | null | undefined): string {
  if (!policy || !isToolEgressRestricted(policy)) return '';
  const fmt = (list: ToolEgressEntry[] | undefined) =>
    list === undefined
      ? '-'
      : list
          .map((e) => `${e.kind === 'wildcard' ? '*.' : ''}${e.host}${e.port === null ? '' : `:${e.port}`}`)
          .sort()
          .join(',');
  return `c=${fmt(policy.company)};a=${fmt(policy.agent)}`;
}

export interface ToolEgressTarget {
  /** Lowercase ASCII host (no port, user info, path or query). */
  host: string;
  port: number;
  isIpv4: boolean;
}

export type ToolEgressTargetParse =
  | { ok: true; target: ToolEgressTarget }
  | { ok: false; host: string | null };

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

/** Host part for logs only: never user info, path, query or port. */
function logHost(rawHost: string): string | null {
  const h = rawHost.replace(/^.*@/, '').replace(/:[0-9]*$/, '').toLowerCase().slice(0, 253);
  return h || null;
}

/**
 * Parse a destination URL for the allow-list. Rejects user info, non-http(s) schemes, IPv6
 * literals, non-dotted-decimal IPv4 forms, trailing-dot and percent-encoded hosts.
 */
export function parseToolEgressTarget(url: string | URL): ToolEgressTargetParse {
  const raw = (typeof url === 'string' ? url : url.href).replace(/[\t\n\r]/g, '').trim();
  const m = /^([a-z][a-z0-9+.-]*):[/\\]*([^/\\?#]*)/i.exec(raw);
  if (!m) return { ok: false, host: null };
  const scheme = m[1]!.toLowerCase();
  const authority = m[2]!;
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, host: logHost(authority) };
  if (authority.includes('@')) return { ok: false, host: logHost(authority) };
  if (authority.startsWith('[')) return { ok: false, host: null };
  const colon = authority.lastIndexOf(':');
  const rawHost = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
  if (!rawHost || rawHost.endsWith('.') || rawHost.includes('%')) return { ok: false, host: logHost(rawHost) };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, host: logHost(rawHost) };
  }
  if (parsed.username || parsed.password) return { ok: false, host: logHost(parsed.hostname) };
  const host = parsed.hostname;
  if (!host || host.startsWith('[') || host.endsWith('.')) return { ok: false, host: host ? logHost(host) : null };
  const isIpv4 = isCanonicalIpv4(host);
  if (isIpv4 && rawHost !== host) return { ok: false, host };
  if (!isIpv4 && looksLikeIpv4Literal(host)) return { ok: false, host };
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[parsed.protocol];
  if (!port) return { ok: false, host };
  return { ok: true, target: { host, port, isIpv4 } };
}

function entryMatches(entry: ToolEgressEntry, target: ToolEgressTarget): boolean {
  if (entry.port !== null && entry.port !== target.port) return false;
  switch (entry.kind) {
    case 'ipv4':
      return target.isIpv4 && target.host === entry.host;
    case 'host':
      return !target.isIpv4 && target.host === entry.host;
    case 'wildcard':
      return !target.isIpv4 && target.host.length > entry.host.length + 1 && target.host.endsWith(`.${entry.host}`);
    default:
      return false;
  }
}

export type ToolEgressDecision =
  | { allowed: true; host: string | null }
  | { allowed: false; reason: 'egress_not_allowed'; host: string | null };

/** Decide one destination URL. Unrestricted policy → always allowed (URL not inspected). */
export function checkToolEgressTarget(policy: ToolEgressPolicy | null | undefined, url: string | URL): ToolEgressDecision {
  if (!policy || !isToolEgressRestricted(policy)) return { allowed: true, host: null };
  const parsed = parseToolEgressTarget(url);
  if (!parsed.ok) return { allowed: false, reason: 'egress_not_allowed', host: parsed.host };
  const { target } = parsed;
  for (const list of [policy.company, policy.agent]) {
    if (list === undefined) continue;
    if (!list.some((entry) => entryMatches(entry, target))) {
      return { allowed: false, reason: 'egress_not_allowed', host: target.host };
    }
  }
  return { allowed: true, host: target.host };
}

/** A request (or a redirect hop) to a host outside the tool allow-list. Carries the host only. */
export class ToolEgressBlockedError extends Error {
  readonly reason = 'egress_not_allowed' as const;
  constructor(readonly host: string | null) {
    super(host ? `Outbound host not allowed for agent tools: ${host}` : 'Outbound host not allowed for agent tools');
    this.name = 'ToolEgressBlockedError';
  }
}

export function isToolEgressBlockedError(err: unknown): err is ToolEgressBlockedError {
  return err instanceof ToolEgressBlockedError || (err instanceof Error && err.name === 'ToolEgressBlockedError');
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Absolute next-hop URL, keeping any host in the Location header in its raw form for checking. */
function nextHopUrl(location: string, current: string): string {
  const loc = location.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(loc)) return loc;
  if (/^[/\\]{2}/.test(loc)) return `${new URL(current).protocol}${loc}`;
  return new URL(loc, current).href;
}

export interface FetchWithToolEgressOptions {
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  /**
   * Extra request headers that carry credentials (e.g. configured MCP server headers). They are
   * dropped, like Authorization, Proxy-Authorization and Cookie, when a redirect changes origin.
   */
  credentialHeaders?: readonly string[];
  /**
   * Top-level keys of a JSON request body that carry credentials (e.g. `api_key`). They are
   * removed from a body that is re-sent to a different origin; a body that cannot be read as a
   * JSON object is not re-sent there (the redirect is refused).
   */
  credentialBodyKeys?: readonly string[];
}

/** Body to re-send on a cross-origin hop with credential keys removed; throws when it cannot. */
function bodyWithoutCredentialKeys(body: RequestInit['body'], keys: readonly string[]): RequestInit['body'] {
  if (body === undefined || body === null || keys.length === 0) return body;
  let parsed: unknown;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Redirect to another origin refused: the request body could not be cleared of credentials.');
  }
  const copy = { ...(parsed as Record<string, unknown>) };
  for (const key of keys) delete copy[key];
  return JSON.stringify(copy);
}

/**
 * `fetch` that keeps every hop on the tool allow-list. Unrestricted policy → plain
 * `fetch(url, init)` (unchanged behaviour). Restricted → the first URL and every redirect
 * target are checked; redirects are followed by hand (bounded), credentials (Authorization,
 * Proxy-Authorization, Cookie, `credentialHeaders` and `credentialBodyKeys`) are dropped when
 * the origin changes, and 303 (or 301/302 after POST) switch to GET as fetch does.
 * Throws {@link ToolEgressBlockedError} on a host outside the list.
 */
export async function fetchWithToolEgress(
  url: string | URL,
  init: RequestInit | undefined,
  policy: ToolEgressPolicy | null | undefined,
  options: FetchWithToolEgressOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!isToolEgressRestricted(policy)) return fetchImpl(url, init);
  const maxRedirects = options.maxRedirects ?? TOOL_EGRESS_MAX_REDIRECTS;

  let current = typeof url === 'string' ? url : url.href;
  let method = (init?.method ?? 'GET').toUpperCase();
  let body = init?.body;
  const headers = new Headers(init?.headers);

  for (let hop = 0; ; hop += 1) {
    const decision = checkToolEgressTarget(policy, current);
    if (!decision.allowed) throw new ToolEgressBlockedError(decision.host);
    const res = await fetchImpl(current, { ...init, method, body, headers, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    await res.body?.cancel().catch(() => undefined);
    if (hop >= maxRedirects) throw new Error(`Too many redirects (more than ${maxRedirects}).`);

    let next: string;
    try {
      next = nextHopUrl(location, current);
    } catch {
      throw new ToolEgressBlockedError(null);
    }
    if ((res.status === 303 && method !== 'HEAD') || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    if (originOf(next) !== originOf(current)) {
      headers.delete('authorization');
      headers.delete('proxy-authorization');
      headers.delete('cookie');
      for (const name of options.credentialHeaders ?? []) headers.delete(name);
      body = bodyWithoutCredentialKeys(body, options.credentialBodyKeys ?? []);
    }
    current = next;
  }
}

/** MCP server URL from its definition (`urlEnvVar` overrides `url`). */
export function mcpServerUrlFromDefinition(
  def: { url?: string; urlEnvVar?: string },
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = (def.urlEnvVar ? env[def.urlEnvVar]?.trim() : undefined) || def.url?.trim();
  return raw || null;
}

export interface ToolEgressMcpServer {
  namespace: string;
  transport?: string;
  url?: string;
  urlEnvVar?: string;
}

export interface ToolEgressTargetContext {
  companySettings?: CompanySettings | null;
  agentRuntime?: AgentRuntimeConfig | null;
  /** MCP servers allowed for the agent (namespace + definition). */
  mcpServers?: ToolEgressMcpServer[];
  env?: Record<string, string | undefined>;
}

function idSet(ids: readonly string[]): Set<string> {
  return new Set(ids.flatMap((id) => [id, toolKeyForId(id)]));
}
const SEARXNG_NAMES = idSet(SEARXNG_TOOLSET_TOOL_IDS);
const TAVILY_NAMES = idSet(TAVILY_TOOLSET_TOOL_IDS);
const NITTER_NAMES = idSet(NITTER_TOOLSET_TOOL_IDS);

/** Tools whose outbound host is checked (static ids; HTTP MCP tools are matched by server). */
export const TOOL_EGRESS_COVERED_TOOL_IDS = [
  ...SEARXNG_TOOLSET_TOOL_IDS,
  ...TAVILY_TOOLSET_TOOL_IDS,
  ...NITTER_TOOLSET_TOOL_IDS,
] as const;

/**
 * Outbound URLs a tool call will contact, from configuration (never from tool arguments):
 * SearXNG base URL (agent → company → env), Tavily API, NITTER_URL, HTTP MCP server URLs.
 */
export function resolveToolEgressTargets(names: readonly string[], ctx: ToolEgressTargetContext): string[] {
  const env = ctx.env ?? process.env;
  const urls = new Set<string>();
  for (const name of names) {
    if (SEARXNG_NAMES.has(name)) {
      const base = resolveSearxngBaseUrl(ctx.companySettings ?? null, ctx.agentRuntime ?? null);
      if (base) urls.add(base);
    } else if (TAVILY_NAMES.has(name)) {
      urls.add(TAVILY_API_ORIGIN);
    } else if (NITTER_NAMES.has(name)) {
      const nitter = env.NITTER_URL?.trim();
      if (nitter) urls.add(nitter);
    }
    for (const server of ctx.mcpServers ?? []) {
      if (server.transport !== 'http' || !name.startsWith(`${server.namespace}_`)) continue;
      const url = mcpServerUrlFromDefinition(server, env);
      // An HTTP server without a usable URL is never connected; nothing to check.
      if (url) urls.add(url);
    }
  }
  return [...urls];
}
