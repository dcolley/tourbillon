import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  parseToolEgressEntry,
  sanitizeToolEgressAllowList,
  resolveToolEgressAllowListInput,
  resolveToolEgressPolicy,
  isToolEgressRestricted,
  isStoredToolEgressAllowListMalformed,
  malformedToolEgressAllowListWarning,
  checkToolEgressTarget,
  parseToolEgressTarget,
  fetchWithToolEgress,
  ToolEgressBlockedError,
  ToolEgressAllowListValidationError,
  resolveToolEgressTargets,
  TAVILY_API_ORIGIN,
  TOOL_EGRESS_COVERED_TOOL_IDS,
} from '../tool-egress';
import { mergeCompanySettings, parseCompanySettings } from '../company-settings';

describe('parseToolEgressEntry', () => {
  it('accepts exact hosts, leading wildcards and dotted-decimal IPv4, with optional ports', () => {
    assert.equal(parseToolEgressEntry('Search.Example.COM').ok && (parseToolEgressEntry('Search.Example.COM') as any).entry, 'search.example.com');
    assert.equal((parseToolEgressEntry('*.Example.com:8443') as any).entry, '*.example.com:8443');
    assert.equal((parseToolEgressEntry('203.0.113.7:80') as any).entry, '203.0.113.7:80');
  });

  it('normalises IDN to punycode', () => {
    const r = parseToolEgressEntry('bücher.example');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.entry, 'xn--bcher-kva.example');
  });

  it('rejects URLs, userinfo, paths, wildcards that are not leading, trailing dots and IPv6', () => {
    for (const raw of [
      'https://example.com',
      'user@example.com',
      'example.com/path',
      'example.*.com',
      'example.com.',
      '[::1]',
      '::1',
      '*',
      '',
    ]) {
      assert.equal(parseToolEgressEntry(raw).ok, false, raw);
    }
  });

  it('rejects non-dotted-decimal IPv4 forms', () => {
    for (const raw of ['2130706433', '0177.0.0.1', '0x7f.0.0.1', '127.1', '127.0.0.1/8']) {
      assert.equal(parseToolEgressEntry(raw).ok, false, raw);
    }
  });
});

describe('sanitizeToolEgressAllowList / resolveToolEgressAllowListInput', () => {
  it('de-duplicates and lowercases; off clears the field', () => {
    assert.deepEqual(sanitizeToolEgressAllowList(['Example.com', 'example.com', ' *.x.COM ']), [
      'example.com',
      '*.x.com',
    ]);
    assert.equal(resolveToolEgressAllowListInput('off', ['example.com']), null);
    assert.deepEqual(resolveToolEgressAllowListInput('list', []), []);
  });

  it('refuses bad write shapes with a clear ToolEgressAllowListValidationError', () => {
    const refused = (fn: () => unknown, pattern: RegExp) =>
      assert.throws(fn, (err: unknown) => err instanceof ToolEgressAllowListValidationError && pattern.test(err.message));
    refused(() => resolveToolEgressAllowListInput('list', 'ok.example'), /must be a list of hosts/);
    refused(() => resolveToolEgressAllowListInput('list', { hosts: ['ok.example'] }), /must be a list of hosts/);
    refused(() => resolveToolEgressAllowListInput('list', undefined), /must be a list of hosts/);
    refused(() => resolveToolEgressAllowListInput('list', ['ok.example', 7]), /must be a string/);
    refused(() => resolveToolEgressAllowListInput('list', ['ok.example', null]), /must be a string/);
    refused(() => resolveToolEgressAllowListInput('list', ['https://bad.example/x']), /bad\.example.*not a URL/);
    refused(() => resolveToolEgressAllowListInput('list', Array.from({ length: 1001 }, (_, i) => `h${i}.example`)), /At most/);
    refused(() => resolveToolEgressAllowListInput('list', Array.from({ length: 201 }, (_, i) => `h${i}.example`)), /At most 200/);
    refused(() => resolveToolEgressAllowListInput('maybe', []), /Mode must be 'off' or 'list'/);
    // A missing mode never clears a list silently.
    refused(() => resolveToolEgressAllowListInput(undefined, []), /Mode must be/);
    refused(() => resolveToolEgressAllowListInput(null, ['ok.example']), /Mode must be/);
    refused(() => resolveToolEgressAllowListInput('off', 'ok.example'), /must be a list of hosts/);
  });

  it('detects a malformed stored list; the warning names ids only', () => {
    assert.equal(isStoredToolEgressAllowListMalformed(undefined), false);
    assert.equal(isStoredToolEgressAllowListMalformed(null), false);
    assert.equal(isStoredToolEgressAllowListMalformed([]), false);
    assert.equal(isStoredToolEgressAllowListMalformed(['ok.example', '*.ok.example:443']), false);
    assert.equal(isStoredToolEgressAllowListMalformed('ok.example'), true);
    assert.equal(isStoredToolEgressAllowListMalformed({ hosts: [] }), true);
    assert.equal(isStoredToolEgressAllowListMalformed(['ok.example', 7]), true);
    assert.equal(isStoredToolEgressAllowListMalformed(['https://secret-host.example/x?k=v']), true);
    const line = malformedToolEgressAllowListWarning({
      companyId: 'co-1',
      companyList: ['https://secret-host.example/x?k=v'],
      agentId: 'ag-1',
      agentList: ['ok.example'],
    });
    assert.equal(
      line,
      '[tool-egress] malformed outbound host allow-list for company co-1; unreadable entries match no host until the list is saved again',
    );
    assert.match(
      malformedToolEgressAllowListWarning({ companyId: 'co-1', companyList: 5, agentId: 'ag-1', agentList: 'x' })!,
      /for company co-1, agent ag-1;/,
    );
    assert.equal(malformedToolEgressAllowListWarning({ companyId: 'co-1', companyList: ['ok.example'] }), null);
    assert.equal(malformedToolEgressAllowListWarning({ companyId: 'co-1' }), null);
  });
});

describe('checkToolEgressTarget', () => {
  const policy = resolveToolEgressPolicy({ toolEgressAllowList: ['api.example.com', '*.cdn.example', '203.0.113.7'] });

  it('allows every host when no list is set', () => {
    assert.deepEqual(checkToolEgressTarget({}, 'https://evil.example/x?k=1'), { allowed: true, host: null });
    assert.deepEqual(checkToolEgressTarget(undefined, 'https://evil.example'), { allowed: true, host: null });
  });

  it('allows listed hosts and subdomains of a leading wildcard', () => {
    assert.equal(checkToolEgressTarget(policy, 'https://api.example.com/v1').allowed, true);
    assert.equal(checkToolEgressTarget(policy, 'https://a.cdn.example/x').allowed, true);
    assert.equal(checkToolEgressTarget(policy, 'http://203.0.113.7/').allowed, true);
  });

  it('does not treat a wildcard as matching the apex', () => {
    assert.deepEqual(checkToolEgressTarget(policy, 'https://cdn.example/'), {
      allowed: false,
      reason: 'egress_not_allowed',
      host: 'cdn.example',
    });
  });

  it('rejects userinfo, trailing-dot hosts, IP forms other than dotted decimal and IPv6', () => {
    for (const url of [
      'https://user:pass@api.example.com/',
      'https://api.example.com./',
      'http://2130706433/',
      'http://0177.0.0.1/',
      'http://0x7f.0.0.1/',
      'http://[::ffff:203.0.113.7]/',
      'http://[2001:db8::1]/',
    ]) {
      const d = checkToolEgressTarget(policy, url);
      assert.equal(d.allowed, false, url);
      assert.equal(d.reason, 'egress_not_allowed');
      if ('host' in d && d.host) assert.ok(!d.host.includes('@') && !d.host.includes('/'), d.host);
    }
  });

  it('matches ports only when the entry names one', () => {
    const withPort = resolveToolEgressPolicy({ toolEgressAllowList: ['api.example.com:443'] });
    assert.equal(checkToolEgressTarget(withPort, 'https://api.example.com/').allowed, true);
    assert.equal(checkToolEgressTarget(withPort, 'http://api.example.com/').allowed, false);
  });

  it('requires a host to match both company and agent lists when both are set', () => {
    const both = resolveToolEgressPolicy(
      { toolEgressAllowList: ['a.example.com', 'b.example.com'] },
      { toolEgressAllowList: ['b.example.com', 'c.example.com'] },
    );
    assert.equal(checkToolEgressTarget(both, 'https://b.example.com/').allowed, true);
    assert.equal(checkToolEgressTarget(both, 'https://a.example.com/').allowed, false);
    assert.equal(checkToolEgressTarget(both, 'https://c.example.com/').allowed, false);
  });

  it('an empty list allows no host', () => {
    const empty = resolveToolEgressPolicy({ toolEgressAllowList: [] });
    assert.equal(isToolEgressRestricted(empty), true);
    assert.equal(checkToolEgressTarget(empty, 'https://api.example.com/').allowed, false);
  });

  it('IPv6 hosts are refused under "Only these hosts" and allowed under allow-all', () => {
    const open = resolveToolEgressPolicy({});
    for (const url of ['https://[2001:db8::1]/', 'http://[::1]:8080/p', 'http://[::ffff:203.0.113.7]/']) {
      assert.equal(checkToolEgressTarget(open, url).allowed, true, url);
      assert.equal(checkToolEgressTarget(null, url).allowed, true, url);
    }
    // IPv6 cannot be listed: the entry is refused on save, and an IPv6 destination is refused
    // while any list is set, even one that allows other hosts.
    assert.equal(parseToolEgressEntry('[2001:db8::1]').ok, false);
    assert.equal(parseToolEgressEntry('2001:db8::1').ok, false);
    const listed = resolveToolEgressPolicy({ toolEgressAllowList: ['api.example.com', '203.0.113.7'] });
    for (const url of ['https://[2001:db8::1]/', 'http://[::1]:8080/p', 'http://[::ffff:203.0.113.7]/']) {
      assert.equal(checkToolEgressTarget(listed, url).allowed, false, url);
    }
  });

  it('IPv4 entries match that exact address only', () => {
    const ip = resolveToolEgressPolicy({ toolEgressAllowList: ['203.0.113.7'] });
    assert.equal(checkToolEgressTarget(ip, 'http://203.0.113.7/').allowed, true);
    assert.equal(checkToolEgressTarget(ip, 'https://203.0.113.7:8443/').allowed, true);
    for (const url of ['http://203.0.113.70/', 'http://203.0.113.8/', 'http://1.203.0.113.7/', 'http://203.0.113.7.nip.io/']) {
      assert.equal(checkToolEgressTarget(ip, url).allowed, false, url);
    }
    // A host entry never matches an IP, and wildcards cannot be written for IPs.
    const host = resolveToolEgressPolicy({ toolEgressAllowList: ['*.example.com'] });
    assert.equal(checkToolEgressTarget(host, 'http://203.0.113.7/').allowed, false);
    assert.equal(parseToolEgressEntry('*.203.0.113.7').ok, false);
    assert.equal(parseToolEgressEntry('203.0.113.*').ok, false);
  });
});

describe('checkToolEgressTarget: host matching edge cases', () => {
  const policy = resolveToolEgressPolicy({ toolEgressAllowList: ['api.example.com', 'xn--bcher-kva.example', '203.0.113.7'] });
  const allowed = (url: string) => checkToolEgressTarget(policy, url).allowed;

  it('matches case-insensitively', () => {
    assert.equal(allowed('HTTPS://API.EXAMPLE.COM/V1'), true);
  });

  it('matches IDN hosts in either form', () => {
    assert.equal(allowed('https://bücher.example/'), true);
    assert.equal(allowed('https://BÜCHER.example/'), true);
    assert.equal(allowed('https://xn--bcher-kva.example/'), true);
    const unicodeEntry = resolveToolEgressPolicy({ toolEgressAllowList: ['bücher.example'] });
    assert.equal(checkToolEgressTarget(unicodeEntry, 'https://xn--bcher-kva.example/').allowed, true);
  });

  it('treats an entry without a port as any port', () => {
    assert.equal(allowed('https://api.example.com:8443/'), true);
    assert.equal(allowed('http://api.example.com:80/'), true);
  });

  it('rejects userinfo and delimiter tricks that point elsewhere', () => {
    for (const url of [
      'https://api.example.com@evil.example/',
      'https://api.example.com:443@evil.example/',
      'https://evil.example\\@api.example.com/',
      'https://evil.example#@api.example.com/',
      'https://evil.example?@api.example.com/',
      'https://evil.example/@api.example.com/',
      'https://@api.example.com/',
    ]) {
      assert.equal(allowed(url), false, url);
    }
  });

  it('rejects other notations of a listed IPv4 address', () => {
    assert.equal(allowed('http://203.0.113.7/'), true);
    for (const url of [
      'http://3405803783/',
      'http://0xcb.0.113.7/',
      'http://0xcb007107/',
      'http://0313.0.0161.07/',
      'http://203.0.29447/',
      'http://203.29447/'.replace('29447', '0x7107'),
      'http://[::ffff:cb00:7107]/',
      'http://[::ffff:203.0.113.7]/',
    ]) {
      assert.equal(allowed(url), false, url);
    }
  });

  it('rejects trailing-dot hosts, percent-encoded hosts and non-http schemes', () => {
    for (const url of [
      'https://api.example.com./',
      'https://api.example.com.:443/',
      'https://api%2eexample.com/',
      'https://%61pi.example.com/',
      'ftp://api.example.com/',
      'ws://api.example.com/',
      'file:///etc/passwd',
      'not a url',
    ]) {
      assert.equal(allowed(url), false, url);
    }
    assert.equal(parseToolEgressEntry('api.example.com.').ok, false);
  });

  it('a stored list that is not an array allows nothing', () => {
    const malformed = resolveToolEgressPolicy({ toolEgressAllowList: 'api.example.com' as unknown as string[] });
    assert.equal(isToolEgressRestricted(malformed), true);
    assert.equal(checkToolEgressTarget(malformed, 'https://api.example.com/').allowed, false);
  });
});

describe('parseToolEgressTarget', () => {
  it('returns the host only (never a URL with path or query)', () => {
    const p = parseToolEgressTarget('https://API.Example.com:8443/path?q=1#x');
    assert.equal(p.ok, true);
    if (p.ok) {
      assert.equal(p.target.host, 'api.example.com');
      assert.equal(p.target.port, 8443);
    }
  });
});

describe('fetchWithToolEgress', () => {
  it('uses plain fetch when unrestricted', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response('ok');
    }) as typeof fetch;
    const res = await fetchWithToolEgress('https://anywhere.test/', {}, {}, { fetchImpl });
    assert.equal(await res.text(), 'ok');
    assert.deepEqual(calls, ['https://anywhere.test/']);
  });

  it('checks the first URL and every redirect hop against the list', async () => {
    const hops: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      hops.push(String(url));
      if (hops.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://api.example.com/next' } });
      }
      return new Response('done');
    }) as typeof fetch;
    const policy = resolveToolEgressPolicy({ toolEgressAllowList: ['start.example', 'api.example.com'] });
    const res = await fetchWithToolEgress('https://start.example/', {}, policy, { fetchImpl });
    assert.equal(await res.text(), 'done');
    assert.deepEqual(hops, ['https://start.example/', 'https://api.example.com/next']);
  });

  it('throws ToolEgressBlockedError with the host when a redirect is off the list', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/x?token=secret' } })) as typeof fetch;
    const policy = resolveToolEgressPolicy({ toolEgressAllowList: ['start.example'] });
    await assert.rejects(
      () => fetchWithToolEgress('https://start.example/', {}, policy, { fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof ToolEgressBlockedError);
        assert.equal(err.host, 'evil.example');
        assert.ok(!String(err.message).includes('token'));
        return true;
      },
    );
  });
});

describe('fetchWithToolEgress: redirect handling', () => {
  type Hop = { url: string; method: string; body: unknown; auth: string | null };
  function scripted(responses: Array<() => Response>) {
    const hops: Hop[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      hops.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body,
        auth: new Headers(init?.headers).get('authorization'),
      });
      assert.equal(init?.redirect, 'manual', 'redirects are never followed automatically');
      const next = responses[hops.length - 1];
      return next ? next() : new Response('end');
    }) as typeof fetch;
    return { hops, fetchImpl };
  }
  const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
  const policy = resolveToolEgressPolicy({ toolEgressAllowList: ['a.example', 'b.example', '203.0.113.7'] });

  it('blocks a scheme-relative redirect to another notation of a listed IP', async () => {
    const { fetchImpl } = scripted([redirect('//3405803783/x')]);
    await assert.rejects(() => fetchWithToolEgress('https://a.example/', {}, policy, { fetchImpl }), ToolEgressBlockedError);
  });

  it('blocks a redirect to an IPv4-mapped IPv6 literal and to userinfo', async () => {
    for (const loc of ['http://[::ffff:203.0.113.7]/', 'https://a.example@evil.example/']) {
      const { fetchImpl } = scripted([redirect(loc)]);
      await assert.rejects(() => fetchWithToolEgress('https://a.example/', {}, policy, { fetchImpl }), ToolEgressBlockedError, loc);
    }
  });

  it('follows relative redirects on the same host', async () => {
    const { hops, fetchImpl } = scripted([redirect('/next?x=1')]);
    await fetchWithToolEgress('https://a.example/start', {}, policy, { fetchImpl });
    assert.deepEqual(hops.map((h) => h.url), ['https://a.example/start', 'https://a.example/next?x=1']);
  });

  it('drops Authorization when the origin changes, keeps it on the same origin', async () => {
    const { hops, fetchImpl } = scripted([redirect('/same'), redirect('https://b.example/other')]);
    await fetchWithToolEgress('https://a.example/', { headers: { Authorization: 'Bearer k' } }, policy, { fetchImpl });
    assert.deepEqual(hops.map((h) => h.auth), ['Bearer k', 'Bearer k', null]);
  });

  it('switches to GET without a body on 303 and after POST on 302; keeps both on 307', async () => {
    const a = scripted([redirect('/r', 303)]);
    await fetchWithToolEgress('https://a.example/', { method: 'POST', body: 'x' }, policy, { fetchImpl: a.fetchImpl });
    assert.deepEqual(a.hops.map((h) => [h.method, h.body]), [['POST', 'x'], ['GET', undefined]]);
    const b = scripted([redirect('/r', 307)]);
    await fetchWithToolEgress('https://a.example/', { method: 'POST', body: 'x' }, policy, { fetchImpl: b.fetchImpl });
    assert.deepEqual(b.hops.map((h) => [h.method, h.body]), [['POST', 'x'], ['POST', 'x']]);
  });

  it('stops after the redirect limit', async () => {
    const { fetchImpl } = scripted(Array.from({ length: 20 }, () => redirect('/loop')));
    await assert.rejects(
      () => fetchWithToolEgress('https://a.example/', {}, policy, { fetchImpl, maxRedirects: 3 }),
      /Too many redirects/,
    );
  });

  it('works with the real fetch: a redirect off the list is never requested', async () => {
    const seen: string[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      seen.push(`${req.headers.host}${req.url}`);
      if (req.url === '/start') {
        res.writeHead(302, { location: '/hop' }).end();
      } else if (req.url === '/hop') {
        res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/off-list` }).end();
      } else {
        res.writeHead(200).end('reached');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const local = resolveToolEgressPolicy({ toolEgressAllowList: [`127.0.0.1:${port}`] });
      await assert.rejects(
        () => fetchWithToolEgress(`http://127.0.0.1:${port}/start`, {}, local),
        (err: unknown) => err instanceof ToolEgressBlockedError && err.host === 'localhost',
      );
      assert.deepEqual(seen, [`127.0.0.1:${port}/start`, `127.0.0.1:${port}/hop`]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('resolveToolEgressTargets', () => {
  it('covers SearXNG, Tavily, Nitter and HTTP MCP from configuration', () => {
    assert.ok(TOOL_EGRESS_COVERED_TOOL_IDS.includes('searxngSearch'));
    const urls = resolveToolEgressTargets(['searxngSearchTool', 'webSearchTavily', 'nitterFeedUser', 'buffer_create_draft'], {
      companySettings: { searxngUrl: 'http://searxng.internal:8888/' },
      mcpServers: [{ namespace: 'buffer', transport: 'http', url: 'https://mcp.buffer.com/mcp' }],
      env: { NITTER_URL: 'https://nitter.example' },
    });
    assert.deepEqual(new Set(urls), new Set([
      'http://searxng.internal:8888',
      TAVILY_API_ORIGIN,
      'https://nitter.example',
      'https://mcp.buffer.com/mcp',
    ]));
  });
});

describe('company settings storage', () => {
  it('keeps the list through parse and unrelated settings saves', () => {
    const stored = { searxngUrl: 'http://s.test', toolEgressAllowList: ['s.test'] };
    assert.deepEqual(parseCompanySettings(stored).toolEgressAllowList, ['s.test']);
    assert.deepEqual(mergeCompanySettings(stored, { tavilyApiKey: 'k' }).toolEgressAllowList, ['s.test']);
    assert.equal('toolEgressAllowList' in parseCompanySettings({ searxngUrl: 'http://s.test' }), false);
    assert.deepEqual(mergeCompanySettings({}, { toolEgressAllowList: [] }).toolEgressAllowList, []);
  });
});
