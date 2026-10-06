import type { SandboxIsolation } from './execution-workspace';

export type EgressAllowListMode = 'off' | 'empty' | 'list';

export type EgressAllowListEntryKind = 'host' | 'wildcard' | 'ipv4' | 'cidr';

export type EgressAllowListParseOk = {
  ok: true;
  entry: string;
  kind: EgressAllowListEntryKind;
};

export type EgressAllowListParseErr = {
  ok: false;
  error: string;
};

export type EgressAllowListParseResult = EgressAllowListParseOk | EgressAllowListParseErr;

export const EGRESS_ALLOW_LIST_HELP = [
  '*.example.com matches subdomains only, not example.com',
  'A CIDR matches only when the agent connects by IP literal, not by hostname',
  'All ports are allowed for a listed host',
] as const;

export const EGRESS_ALLOW_LIST_ISOLATION_WARNING =
  'A non-empty allow-list will refuse to run when isolation is none or seatbelt. Only isolation=bwrap can enforce listed destinations.';

const HOSTNAME_LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export function inferEgressAllowListMode(list: string[] | undefined): EgressAllowListMode {
  if (list === undefined) return 'off';
  if (list.length === 0) return 'empty';
  return 'list';
}

export function parseEgressAllowListMode(raw: unknown): EgressAllowListMode {
  if (raw === 'empty' || raw === 'list' || raw === 'off') return raw;
  return 'off';
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

function isIpv4Cidr(value: string): boolean {
  const slash = value.lastIndexOf('/');
  if (slash === -1) return false;
  const ip = value.slice(0, slash);
  const prefix = value.slice(slash + 1);
  if (!isIpv4Address(ip) || !/^\d+$/.test(prefix)) return false;
  const n = Number(prefix);
  return n >= 0 && n <= 32;
}

function isHostname(value: string): boolean {
  if (!value || value.length > 253) return false;
  if (value.startsWith('.') || value.endsWith('.')) return false;
  if (/^\d+(\.\d+)+$/.test(value)) return false;
  return value.split('.').every((label) => HOSTNAME_LABEL.test(label));
}

function looksLikeIpv6(value: string): boolean {
  if (value.startsWith('[') || value.includes('::')) return true;
  const colonCount = (value.match(/:/g) ?? []).length;
  return colonCount >= 2;
}

export function parseEgressAllowListEntry(raw: string): EgressAllowListParseResult {
  const entry = raw.trim();
  if (!entry) {
    return { ok: false, error: 'Entry is empty.' };
  }
  if (/\s/.test(entry)) {
    return { ok: false, error: 'Whitespace is not allowed inside an entry.' };
  }
  if (entry === '*') {
    return { ok: false, error: 'Bare * is not allowed.' };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(entry) || entry.startsWith('//')) {
    return { ok: false, error: 'URLs are not allowed; enter a host, not a URL.' };
  }
  if (looksLikeIpv6(entry)) {
    return { ok: false, error: 'IPv6 addresses are not allowed.' };
  }
  if (entry.includes(':')) {
    return { ok: false, error: 'Ports are not allowed; all ports are allowed for a listed host.' };
  }
  if (entry.includes('/')) {
    if (isIpv4Cidr(entry)) {
      return { ok: true, entry, kind: 'cidr' };
    }
    return { ok: false, error: 'Paths are not allowed; enter a host only.' };
  }
  if (isIpv4Address(entry)) {
    return { ok: true, entry, kind: 'ipv4' };
  }
  if (entry.startsWith('*.')) {
    const domain = entry.slice(2);
    if (!domain || !isHostname(domain)) {
      return { ok: false, error: 'Enter a wildcard as *.domain (subdomains only).' };
    }
    return { ok: true, entry: entry.toLowerCase(), kind: 'wildcard' };
  }
  if (entry.includes('*')) {
    return { ok: false, error: 'Bare * is not allowed.' };
  }
  if (isHostname(entry)) {
    return { ok: true, entry: entry.toLowerCase(), kind: 'host' };
  }
  return { ok: false, error: 'Enter an exact host, *.domain, IPv4 address, or IPv4 CIDR.' };
}

export function sanitizeEgressAllowList(entries: unknown[]): string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const raw of entries) {
    if (typeof raw !== 'string') {
      throw new Error('Each egress allow-list entry must be a string.');
    }
    const parsed = parseEgressAllowListEntry(raw);
    if (!parsed.ok) {
      throw new Error(`${raw.trim() || '(empty)'}: ${parsed.error}`);
    }
    const key = parsed.entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push(parsed.entry);
  }
  return sanitized;
}

/** `null` unsets the field (Off). An array — including `[]` — replaces allowNetwork. */
export function resolveEgressAllowListInput(
  mode: EgressAllowListMode,
  entries: unknown[],
): string[] | null {
  if (mode === 'off') return null;
  if (mode === 'empty') return [];
  return sanitizeEgressAllowList(entries);
}

export function egressAllowListNeedsBwrap(
  isolation: SandboxIsolation,
  list: string[] | undefined,
): boolean {
  return list !== undefined && list.length > 0 && isolation !== 'bwrap';
}
