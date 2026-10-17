import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  checkBrowserUrl,
  isHostOnBrowserAllowList,
  parseBrowserHostEntry,
  readBrowserHostAllowList,
  type BrowserEgressPolicy,
} from './browser-egress';
import type { HostResolver } from '../egress-private-ranges';

const DNS: Record<string, string[]> = {
  'example.com': ['93.184.216.34'],
  'docs.example.com': ['93.184.216.35'],
  'other.org': ['151.101.1.1'],
  localhost: ['127.0.0.1'],
  'intranet.corp': ['10.1.2.3'],
  'rebind.example.com': ['93.184.216.40', '192.168.1.10'],
  'v6local.example.com': ['::1'],
};
const resolve: HostResolver = async (host) => {
  const ips = DNS[host];
  if (!ips) throw new Error('ENOTFOUND');
  return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const open: BrowserEgressPolicy = { hostAllowList: {}, resolve };

describe('checkBrowserUrl — schemes', () => {
  for (const url of [
    'file:///etc/passwd',
    'FILE:///etc/passwd',
    'data:text/html,<h1>x</h1>',
    'javascript:alert(1)',
    'chrome://settings',
    'view-source:https://example.com',
    'ftp://example.com/x',
    'blob:https://example.com/123',
  ]) {
    it(`refuses ${url.split(':')[0]}:`, async () => {
      const d = await checkBrowserUrl(url, open, { navigation: true });
      assert.equal(d.allowed, false);
      assert.equal(!d.allowed && d.reason, 'scheme_not_allowed');
    });
  }

  it('allows about:blank only for navigation', async () => {
    assert.equal((await checkBrowserUrl('about:blank', open, { navigation: true })).allowed, true);
    assert.equal((await checkBrowserUrl('about:blank', open)).allowed, false);
    assert.equal((await checkBrowserUrl('about:srcdoc', open, { navigation: true })).allowed, false);
  });

  it('refuses user info in the URL', async () => {
    const d = await checkBrowserUrl('https://user:pw@example.com/', open);
    assert.equal(!d.allowed && d.reason, 'credentials_in_url');
  });

  it('refuses unparseable URLs', async () => {
    const d = await checkBrowserUrl('not a url', open);
    assert.equal(!d.allowed && d.reason, 'invalid_url');
  });
});

describe('checkBrowserUrl — local and internal addresses', () => {
  const cases: Array<[string, string]> = [
    ['http://localhost:3002/api', 'private_range'],
    ['http://127.0.0.1/', 'private_range'],
    ['http://2130706433/', 'private_range'], // decimal 127.0.0.1, normalised by URL
    ['http://0x7f.1/', 'private_range'],
    ['http://10.0.0.5/', 'private_range'],
    ['http://172.16.3.4/', 'private_range'],
    ['http://192.168.0.1/', 'private_range'],
    ['http://100.64.1.1/', 'private_range'],
    ['http://0.0.0.0/', 'private_range'],
    ['http://[::1]/', 'private_range'],
    ['http://[fd12::1]/', 'private_range'],
    ['http://[::ffff:127.0.0.1]/', 'private_range'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud_metadata'],
    ['http://[fe80::1]/', 'cloud_metadata'],
    ['http://100.100.100.200/', 'cloud_metadata'],
    ['http://metadata.google.internal/', 'cloud_metadata'],
    ['http://intranet.corp/', 'private_range'],
    ['http://rebind.example.com/', 'private_range'], // any resolved address private → deny
    ['http://v6local.example.com/', 'private_range'],
  ];
  for (const [url, reason] of cases) {
    it(`refuses ${url}`, async () => {
      const d = await checkBrowserUrl(url, open);
      assert.equal(d.allowed, false, url);
      assert.equal(!d.allowed && d.reason, reason, url);
    });
  }

  it('cannot be overridden by listing a private host or IP', async () => {
    const policy: BrowserEgressPolicy = {
      hostAllowList: { company: ['127.0.0.1', 'localhost', '10.0.0.5', '169.254.169.254'] },
      resolve,
    };
    for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.5/', 'http://169.254.169.254/']) {
      assert.equal((await checkBrowserUrl(url, policy)).allowed, false, url);
    }
  });

  it('allows a public host when no list is set', async () => {
    const d = await checkBrowserUrl('https://example.com/page?q=1', open);
    assert.deepEqual(d, { allowed: true, host: 'example.com' });
  });

  it('reports DNS failure as a denial', async () => {
    const d = await checkBrowserUrl('https://nope.invalid/', open);
    assert.equal(!d.allowed && d.reason, 'dns_failed');
  });
});

describe('checkBrowserUrl — outbound host allow-list', () => {
  const listed = (company?: string[], agent?: string[]): BrowserEgressPolicy => ({
    hostAllowList: { ...(company ? { company } : {}), ...(agent ? { agent } : {}) },
    resolve,
  });

  it('refuses a host off the company list', async () => {
    const d = await checkBrowserUrl('https://other.org/', listed(['example.com']));
    assert.equal(!d.allowed && d.reason, 'not_on_allow_list');
    assert.equal(!d.allowed && d.host, 'other.org');
  });

  it('allows a listed host', async () => {
    assert.equal((await checkBrowserUrl('https://example.com/', listed(['example.com']))).allowed, true);
  });

  it('wildcard matches subdomains only', async () => {
    const p = listed(['*.example.com']);
    assert.equal((await checkBrowserUrl('https://docs.example.com/', p)).allowed, true);
    assert.equal((await checkBrowserUrl('https://example.com/', p)).allowed, false);
  });

  it('port-qualified entries only match that port', async () => {
    const p = listed(['example.com:8443']);
    assert.equal((await checkBrowserUrl('https://example.com:8443/', p)).allowed, true);
    assert.equal((await checkBrowserUrl('https://example.com/', p)).allowed, false);
  });

  it('agent list narrows the company list (host must match both)', async () => {
    const p = listed(['example.com', 'other.org'], ['other.org']);
    assert.equal((await checkBrowserUrl('https://other.org/', p)).allowed, true);
    assert.equal((await checkBrowserUrl('https://example.com/', p)).allowed, false);
  });

  it('an empty list allows nothing', async () => {
    assert.equal((await checkBrowserUrl('https://example.com/', listed([]))).allowed, false);
  });

  it('IPv6 literals are refused while a list is set', () => {
    assert.equal(isHostOnBrowserAllowList({ company: ['example.com'] }, '[2606:4700::1]', 443), false);
  });
});

describe('readBrowserHostAllowList', () => {
  it('reads company settings and agent runtimeConfig', () => {
    assert.deepEqual(
      readBrowserHostAllowList({ toolEgressAllowList: ['a.com'] }, { toolEgressAllowList: ['b.com'] }),
      { company: ['a.com'], agent: ['b.com'] },
    );
  });
  it('unset / null = unrestricted', () => {
    assert.deepEqual(readBrowserHostAllowList(null, { toolEgressAllowList: null }), {});
  });
  it('a corrupt stored value still restricts (empty list)', () => {
    assert.deepEqual(readBrowserHostAllowList({ toolEgressAllowList: 'a.com' }, undefined), { company: [] });
  });
});

describe('parseBrowserHostEntry', () => {
  it('parses host, wildcard, ipv4 and port forms', () => {
    assert.deepEqual(parseBrowserHostEntry('Example.COM'), { kind: 'host', host: 'example.com', port: null });
    assert.deepEqual(parseBrowserHostEntry('*.example.com:443'), { kind: 'wildcard', host: 'example.com', port: 443 });
    assert.deepEqual(parseBrowserHostEntry('8.8.8.8'), { kind: 'ipv4', host: '8.8.8.8', port: null });
  });
  it('rejects junk', () => {
    for (const bad of ['', 'http://x.com', 'x.com/path', 'a@b.com', '[::1]', '1.2.3', 'x.com:0', 'x.com:99999']) {
      assert.equal(parseBrowserHostEntry(bad), null, bad);
    }
  });
});
