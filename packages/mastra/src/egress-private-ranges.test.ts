import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  BLOCKED_IPV4_CIDRS,
  authorizeEgressTarget,
  canonicalIp,
  hasPrivateOverride,
  isBlockedPrivateRange,
  isCloudMetadataIp,
  isIpv6Loopback,
  isIpv6Unspecified,
  isLoopbackIp,
  parseIpv6Bytes,
  unwrapIpv4Mapped,
  type HostResolver,
} from './egress-private-ranges';

function mapped(ipv4: string): string {
  return `::ffff:${ipv4}`;
}

function mappedHex(ipv4: string): string {
  const [a, b, c, d] = ipv4.split('.').map(Number);
  const hi = ((a! << 8) | b!).toString(16);
  const lo = ((c! << 8) | d!).toString(16);
  return `::ffff:${hi}:${lo}`;
}

const RANGE_SAMPLES: Array<{ range: string; blocked: string[]; outside: string[] }> = [
  { range: '0.0.0.0/8', blocked: ['0.0.0.0', '0.0.0.1', '0.255.255.255'], outside: ['1.0.0.1'] },
  { range: '127.0.0.0/8', blocked: ['127.0.0.1', '127.0.0.0', '127.255.255.255'], outside: ['128.0.0.1'] },
  { range: '10.0.0.0/8', blocked: ['10.0.0.1', '10.255.255.255'], outside: ['11.0.0.1'] },
  { range: '172.16.0.0/12', blocked: ['172.16.0.1', '172.31.255.255'], outside: ['172.32.0.1', '172.15.255.255'] },
  { range: '192.168.0.0/16', blocked: ['192.168.0.1', '192.168.10.165', '192.168.255.255'], outside: ['192.169.0.1'] },
  { range: '169.254.0.0/16', blocked: ['169.254.0.1', '169.254.169.254', '169.254.255.255'], outside: ['169.255.0.1'] },
  { range: '100.64.0.0/10', blocked: ['100.64.0.1', '100.64.1.1', '100.127.255.255'], outside: ['100.63.255.255', '100.128.0.1'] },
];

describe('blocked private ranges', () => {
  it('lists every required IPv4 CIDR', () => {
    assert.deepEqual([...BLOCKED_IPV4_CIDRS], [
      '0.0.0.0/8',
      '127.0.0.0/8',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '169.254.0.0/16',
      '100.64.0.0/10',
    ]);
  });

  for (const sample of RANGE_SAMPLES) {
    it(`blocks ${sample.range} and IPv4-mapped forms`, () => {
      for (const ip of sample.blocked) {
        assert.equal(isBlockedPrivateRange(ip), true, ip);
        assert.equal(isBlockedPrivateRange(mapped(ip)), true, mapped(ip));
        assert.equal(isBlockedPrivateRange(mappedHex(ip)), true, mappedHex(ip));
      }
      for (const ip of sample.outside) {
        assert.equal(isBlockedPrivateRange(ip), false, ip);
        assert.equal(isBlockedPrivateRange(mapped(ip)), false, mapped(ip));
        assert.equal(isBlockedPrivateRange(mappedHex(ip)), false, mappedHex(ip));
      }
    });
  }

  it('blocks IPv6 loopback, unspecified, ULA, and link-local', () => {
    assert.equal(isIpv6Loopback('::1'), true);
    assert.equal(isIpv6Unspecified('::'), true);
    assert.equal(isBlockedPrivateRange('::1'), true);
    assert.equal(isBlockedPrivateRange('::'), true);
    assert.equal(isBlockedPrivateRange('0:0:0:0:0:0:0:1'), true);
    assert.equal(isBlockedPrivateRange('fc00::1'), true);
    assert.equal(isBlockedPrivateRange('fd12:3456:789a::1'), true);
    assert.equal(isBlockedPrivateRange('fe80::1'), true);
    assert.equal(isBlockedPrivateRange('fe80:0:0:0:0:0:0:1'), true);
  });

  it('does not block public IPv4 or IPv6', () => {
    assert.equal(isBlockedPrivateRange('1.1.1.1'), false);
    assert.equal(isBlockedPrivateRange('8.8.8.8'), false);
    assert.equal(isBlockedPrivateRange('2001:db8::1'), false);
    assert.equal(isBlockedPrivateRange('2606:4700:4700::1111'), false);
    assert.equal(isBlockedPrivateRange(mapped('1.1.1.1')), false);
  });

  it('treats IPv4-mapped loopback as loopback', () => {
    assert.equal(isLoopbackIp('127.0.0.1'), true);
    assert.equal(isLoopbackIp(mapped('127.0.0.1')), true);
    assert.equal(isLoopbackIp(mappedHex('127.0.0.1')), true);
    assert.equal(isLoopbackIp('::1'), true);
    assert.equal(isLoopbackIp('192.168.1.1'), false);
  });

  it('identifies cloud metadata in v4 and mapped v6', () => {
    assert.equal(isCloudMetadataIp('169.254.169.254'), true);
    assert.equal(isCloudMetadataIp(mapped('169.254.169.254')), true);
    assert.equal(isCloudMetadataIp(mappedHex('169.254.169.254')), true);
    assert.equal(isCloudMetadataIp('169.254.169.253'), false);
  });

  it('unwraps dotted and hex IPv4-mapped forms to the same canonical IPv4', () => {
    assert.equal(unwrapIpv4Mapped('::ffff:192.168.10.165'), '192.168.10.165');
    assert.equal(unwrapIpv4Mapped(mappedHex('192.168.10.165')), '192.168.10.165');
    assert.equal(canonicalIp('::ffff:127.0.0.1'), canonicalIp('127.0.0.1'));
    assert.equal(canonicalIp(mappedHex('10.0.0.1')), canonicalIp('10.0.0.1'));
    assert.ok(parseIpv6Bytes('2001:db8::1'));
  });
});

describe('hasPrivateOverride', () => {
  it('never allows cloud metadata, even when listed', () => {
    assert.equal(
      hasPrivateOverride('169.254.169.254', '169.254.169.254', ['169.254.169.254']),
      false,
    );
    assert.equal(
      hasPrivateOverride(mapped('169.254.169.254'), 'metadata', ['169.254.169.254', '169.254.0.0/16']),
      false,
    );
  });

  it('allows loopback only via exact IP (or /32 of that IP), never a wider CIDR or hostname', () => {
    assert.equal(hasPrivateOverride('127.0.0.1', '127.0.0.1', ['127.0.0.1']), true);
    assert.equal(hasPrivateOverride('127.0.0.1', '127.0.0.1', ['127.0.0.1/32']), true);
    assert.equal(hasPrivateOverride('127.0.0.1', '127.0.0.1', ['127.0.0.0/8']), false);
    assert.equal(hasPrivateOverride('127.0.0.1', 'localhost', ['localhost']), false);
    assert.equal(hasPrivateOverride('::1', '::1', ['::1']), true);
    assert.equal(hasPrivateOverride('::1', '::1', ['::1/128']), true);
    assert.equal(hasPrivateOverride('::1', '::1', ['::/128']), false);
    assert.equal(hasPrivateOverride(mapped('127.0.0.1'), '::ffff:127.0.0.1', ['127.0.0.1']), true);
  });

  it('allows other private dests via exact IP, CIDR, or exact hostname — never wildcard', () => {
    assert.equal(hasPrivateOverride('192.168.10.165', '192.168.10.165', ['192.168.10.165']), true);
    assert.equal(hasPrivateOverride('192.168.10.165', '192.168.10.165', ['192.168.10.0/24']), true);
    assert.equal(hasPrivateOverride('192.168.10.165', 'searx.lan', ['searx.lan']), true);
    assert.equal(hasPrivateOverride('192.168.10.165', 'foo.example.com', ['*.example.com']), false);
    assert.equal(hasPrivateOverride('10.1.2.3', '10.1.2.3', ['10.0.0.0/8']), true);
    assert.equal(hasPrivateOverride('100.64.1.2', 'tailscale.example', ['*.example']), false);
    assert.equal(hasPrivateOverride('100.64.1.2', '100.64.1.2', ['100.64.0.0/10']), true);
    assert.equal(hasPrivateOverride('fc00::1', 'fc00::1', ['fc00::/7']), true);
    assert.equal(hasPrivateOverride('fe80::1', 'fe80::1', ['fe80::1']), true);
  });
});

const resolvePublic: HostResolver = async () => [{ address: '1.1.1.1', family: 4 }];
const resolveTo = (ip: string, family: 4 | 6 = 4): HostResolver => async () => [
  { address: ip, family },
];

describe('authorizeEgressTarget', () => {
  it('allows a public allow-listed host and pins the resolved IP', async () => {
    const decision = await authorizeEgressTarget({
      host: 'api.example.com',
      allowList: ['api.example.com'],
      resolve: resolvePublic,
    });
    assert.equal(decision.allowed, true);
    if (decision.allowed) {
      assert.deepEqual(decision.pin, { address: '1.1.1.1', family: 4 });
    }
  });

  it('refuses 127.0.0.1, LAN, CGNAT, metadata, and ::1 by default', async () => {
    const blocked = [
      '127.0.0.1',
      '192.168.10.1',
      '100.64.1.1',
      '169.254.169.254',
      '::1',
    ];
    for (const host of blocked) {
      const decision = await authorizeEgressTarget({
        host,
        allowList: ['api.example.com', '*.example.com'],
      });
      assert.equal(decision.allowed, false, host);
      if (!decision.allowed) {
        assert.equal(decision.status, 403, host);
        assert.ok(
          decision.reason === 'private_range' || decision.reason === 'cloud_metadata',
          `${host} ${decision.reason}`,
        );
      }
    }
  });

  it('refuses a hostname that resolves to a blocked range even when listed via wildcard', async () => {
    const decision = await authorizeEgressTarget({
      host: 'localhost.example',
      allowList: ['*.example', 'localhost.example.com'],
      resolve: resolveTo('127.0.0.1'),
    });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.status, 403);
      assert.equal(decision.reason, 'private_range');
    }
  });

  it('allows an exact-IP LAN entry and refuses *.domain that resolves to LAN', async () => {
    const allowed = await authorizeEgressTarget({
      host: '192.168.10.165',
      allowList: ['192.168.10.165'],
    });
    assert.equal(allowed.allowed, true);

    const wildcard = await authorizeEgressTarget({
      host: 'searx.example.com',
      allowList: ['*.example.com'],
      resolve: resolveTo('192.168.10.165'),
    });
    assert.equal(wildcard.allowed, false);
    if (!wildcard.allowed) {
      assert.equal(wildcard.status, 403);
      assert.equal(wildcard.reason, 'private_range');
    }
  });

  it('allows an exact hostname whose resolved IPs are in that private range', async () => {
    const decision = await authorizeEgressTarget({
      host: 'searx.lan',
      allowList: ['searx.lan'],
      resolve: resolveTo('192.168.10.165'),
    });
    assert.equal(decision.allowed, true);
    if (decision.allowed) {
      assert.equal(decision.pin.address, '192.168.10.165');
    }
  });

  it('refuses metadata even when listed', async () => {
    const decision = await authorizeEgressTarget({
      host: '169.254.169.254',
      allowList: ['169.254.169.254', '169.254.0.0/16'],
    });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.reason, 'cloud_metadata');
      assert.equal(decision.status, 403);
    }
  });

  it('public-internet mode allows public hosts and blocks LAN', async () => {
    const publicOk = await authorizeEgressTarget({
      host: 'example.com',
      allowList: [],
      publicInternet: true,
      resolve: resolvePublic,
    });
    assert.equal(publicOk.allowed, true);

    const lan = await authorizeEgressTarget({
      host: '192.168.10.1',
      allowList: [],
      publicInternet: true,
    });
    assert.equal(lan.allowed, false);
    if (!lan.allowed) {
      assert.equal(lan.status, 403);
      assert.equal(lan.reason, 'private_range');
    }
  });

  it('empty list without public-internet denies without relying on DNS', async () => {
    const decision = await authorizeEgressTarget({
      host: 'example.com',
      allowList: [],
      resolve: async () => {
        throw new Error('should not resolve');
      },
    });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.status, 403);
      assert.equal(decision.reason, 'not_on_allow_list');
    }
  });

  it('refuses the whole host if any resolved IP is private without override', async () => {
    const decision = await authorizeEgressTarget({
      host: 'rebind.example.com',
      allowList: ['rebind.example.com'],
      resolve: async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.reason, 'private_range');
    }
  });

  it('pins IPv4-mapped loopback as IPv4', async () => {
    const decision = await authorizeEgressTarget({
      host: '::ffff:127.0.0.1',
      allowList: ['127.0.0.1'],
    });
    assert.equal(decision.allowed, true);
    if (decision.allowed) {
      assert.deepEqual(decision.pin, { address: '127.0.0.1', family: 4 });
    }
  });
});
