/**
 * S268-S2 (Refs #268): classifier for the real-DNS skip probe in
 * execution-workspace-integration.test.ts.
 *
 * The old skip was a plain `dns.lookup` that only skipped when the lookup
 * THREW. On hosts whose resolver is a fake-IP / sinkhole DNS (DNSPod,
 * AdGuard, Clash TUN, some router DNS - this gate box answers
 * `198.18.0.1` for every name), the lookup succeeds with a non-routable
 * address, the leg never skips, and the proxy leg fails with a 500 instead.
 *
 * This module is test-support policy only: it decides when a system-DNS
 * probe answer set proves the host has no usable real DNS. It is NOT the
 * proxy's allow-list policy - `isBlockedPrivateRange` stays untouched, so
 * the fake-IP benchmark block does not gain product-side meaning here.
 */
import type { LookupAddress } from 'node:dns';
import {
  effectiveIpv4,
  isBlockedPrivateRange,
  matchesIpv4Cidr,
} from './egress-private-ranges';

/**
 * RFC 2544 benchmarking block. Fake-IP resolvers answer every name from
 * 198.18.0.0/15, so a "successful" lookup returning only this range is
 * exactly as useless as a lookup that threw.
 */
export const FAKE_IP_BENCHMARK_V4_CIDR = '198.18.0.0/15';

/**
 * Documentation (TEST-NET) and reserved blocks no real DNS should hand out
 * - classic sinkhole answers alongside the benchmark block.
 */
export const SINKHOLE_V4_EXTRA_CIDRS = [
  '192.0.2.0/24', // TEST-NET-1
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '240.0.0.0/4', // reserved (includes 255.255.255.255)
] as const;

/**
 * True when `address` cannot be the answer of a usable public DNS: private,
 * loopback, 0.0.0.0/8, link-local, CGNAT, IPv6 ULA/link-local/unspecified
 * (all via isBlockedPrivateRange), or the fake-IP benchmark / sinkhole
 * blocks above.
 */
export function isFakeIpOrSinkholeAddress(address: string): boolean {
  if (isBlockedPrivateRange(address)) return true;
  const v4 = effectiveIpv4(address);
  if (v4 && matchesIpv4Cidr(v4, FAKE_IP_BENCHMARK_V4_CIDR)) return true;
  if (v4 && SINKHOLE_V4_EXTRA_CIDRS.some((cidr) => matchesIpv4Cidr(v4, cidr))) return true;
  return false;
}

/**
 * Decide whether a system-DNS probe answer set proves "no usable real DNS".
 * Returns a human-readable skip reason, or null when at least one address
 * is publicly routable (leg should run).
 */
export function classifySystemDnsProbe(answers: LookupAddress[]): string | null {
  if (answers.length === 0) return 'DNS returned no addresses';
  const unusable = answers.filter((a) => isFakeIpOrSinkholeAddress(a.address));
  if (unusable.length === answers.length) {
    return `no public answer (every address is private/loopback/fake-IP: ${unusable
      .map((a) => a.address)
      .join(', ')})`;
  }
  return null;
}
