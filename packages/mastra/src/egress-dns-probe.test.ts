import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  FAKE_IP_BENCHMARK_V4_CIDR,
  classifySystemDnsProbe,
  isFakeIpOrSinkholeAddress,
} from './egress-dns-probe';

// S268-S2 (Refs #268): the real-DNS leg of the egress integration test used
// to skip only when dns.lookup THREW. On fake-IP / sinkhole resolvers every
// name resolves (this gate box answers 198.18.0.1 for everything), so the
// leg failed instead of skipping. These tests pin the classifier that now
// drives the skip - including the exact shape this box's DNS produces.

const v4 = (address: string) => ({ address, family: 4 as const });
const v6 = (address: string) => ({ address, family: 6 as const });

describe('isFakeIpOrSinkholeAddress (S268-S2)', () => {
  it('flags the fake-IP benchmark block, including this box 198.18.0.1 shape', () => {
    assert.equal(FAKE_IP_BENCHMARK_V4_CIDR, '198.18.0.0/15');
    for (const ip of ['198.18.0.0', '198.18.0.1', '198.19.255.254']) {
      assert.equal(isFakeIpOrSinkholeAddress(ip), true, `${ip} (in 198.18.0.0/15) is fake-IP`);
    }
    // Just outside the /15 on both sides stays public.
    assert.equal(isFakeIpOrSinkholeAddress('198.17.255.255'), false, '198.17.255.255 is below the /15');
    assert.equal(isFakeIpOrSinkholeAddress('198.20.0.0'), false, '198.20.0.0 is above the /15');
  });

  it('flags private, loopback, 0.0.0.0 and link-local answers', () => {
    for (const ip of [
      '0.0.0.0',
      '127.0.0.1',
      '10.1.2.3',
      '172.16.5.6',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
    ]) {
      assert.equal(isFakeIpOrSinkholeAddress(ip), true, `${ip} cannot be a real public answer`);
    }
  });

  it('flags unusable IPv6 answers and IPv4-mapped private addresses', () => {
    assert.equal(isFakeIpOrSinkholeAddress('::1'), true, 'IPv6 loopback');
    assert.equal(isFakeIpOrSinkholeAddress('::'), true, 'IPv6 unspecified');
    assert.equal(isFakeIpOrSinkholeAddress('fd12::1'), true, 'ULA fc00::/7');
    assert.equal(isFakeIpOrSinkholeAddress('fe80::1'), true, 'link-local');
    assert.equal(isFakeIpOrSinkholeAddress('::ffff:198.18.0.1'), true, 'v4-mapped fake-IP');
  });

  it('does not flag public answers', () => {
    for (const ip of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '104.16.10.10']) {
      assert.equal(isFakeIpOrSinkholeAddress(ip), false, `${ip} is a usable public answer`);
    }
    assert.equal(isFakeIpOrSinkholeAddress('2606:4700::6810:84e5'), false, 'public IPv6');
  });

  it('flags TEST-NET and reserved sinkhole answers', () => {
    for (const ip of ['192.0.2.1', '198.51.100.5', '203.0.113.42', '255.255.255.255']) {
      assert.equal(isFakeIpOrSinkholeAddress(ip), true, `${ip} is not a real public answer`);
    }
  });
});

describe('classifySystemDnsProbe (S268-S2)', () => {
  it('returns a skip reason for a fake-IP-only answer set (this box: 198.18.0.1)', () => {
    const reason = classifySystemDnsProbe([v4('198.18.0.1')]);
    assert.ok(reason, 'must not report usable DNS');
    assert.match(reason, /no public answer/);
    assert.match(reason, /198\.18\.0\.1/, 'reason names the offending address');
  });

  it('returns a skip reason for empty and for private/loopback-only answer sets', () => {
    assert.match(classifySystemDnsProbe([]) ?? '', /no addresses/);
    assert.ok(classifySystemDnsProbe([v4('127.0.0.1'), v4('198.18.0.1')]), 'loopback+fake-IP only -> skip');
    assert.ok(classifySystemDnsProbe([v6('::1')]), 'IPv6 loopback only -> skip');
    assert.ok(classifySystemDnsProbe([v4('0.0.0.0')]), '0.0.0.0 only -> skip');
  });

  it('reports usable DNS when at least one answer is public', () => {
    assert.equal(classifySystemDnsProbe([v4('93.184.216.34')]), null, 'public answer -> leg runs');
    assert.equal(
      classifySystemDnsProbe([v4('198.18.0.1'), v4('93.184.216.34')]),
      null,
      'mixed set with a public address must still run the leg',
    );
    assert.equal(classifySystemDnsProbe([v6('2606:4700::6810:84e5')]), null, 'public IPv6 -> leg runs');
  });
});
