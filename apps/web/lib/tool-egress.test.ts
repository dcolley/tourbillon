/**
 * Outbound host allow-list for agent tools, request side: web search / Nitter clients and the
 * route denial helper (no network, no DB).
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://tool-egress-test:unused@127.0.0.1:1/unused';

type Shared = typeof import('@tourbillon/shared');
type Egress = typeof import('./tool-egress');
type Form = typeof import('./tool-egress-form');

let shared: Shared;
let egress: Egress;
let form: Form;
let searxng: typeof import('./searxng/client');
let tavily: typeof import('./tavily/client');
let nitter: typeof import('./nitter/client');

const realFetch = globalThis.fetch;
const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
let respond: (url: string) => Response = () => new Response('{}', { status: 200 });

before(async () => {
  shared = await import('@tourbillon/shared');
  egress = await import('./tool-egress');
  form = await import('./tool-egress-form');
  searxng = await import('./searxng/client');
  tavily = await import('./tavily/client');
  nitter = await import('./nitter/client');
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), redirect: init?.redirect });
    return respond(String(url));
  }) as typeof fetch;
});

afterEach(() => {
  calls.length = 0;
  respond = () => new Response('{}', { status: 200 });
  egress.setToolEgressRecorderForTests();
});

after(() => {
  globalThis.fetch = realFetch;
});

const policy = (hosts: string[]) => shared.resolveToolEgressPolicy({ toolEgressAllowList: hosts });

describe('tool egress: search clients', () => {
  it('SearXNG: no list → plain fetch with default redirects', async () => {
    respond = () => new Response(JSON.stringify({ results: [] }), { status: 200 });
    const res = await searxng.runSearxngSearch({ baseUrl: 'http://searxng.test', query: 'q', maxResults: 3 });
    assert.equal(res.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.redirect, undefined);
  });

  it('SearXNG: host off the list is refused before any request', async () => {
    await assert.rejects(
      () => searxng.runSearxngSearch({ baseUrl: 'http://searxng.test', query: 'q', maxResults: 3, egressPolicy: policy(['other.test']) }),
      (err: unknown) => err instanceof shared.ToolEgressBlockedError && err.host === 'searxng.test',
    );
    assert.equal(calls.length, 0);
  });

  it('SearXNG: listed host runs with manual redirects', async () => {
    respond = () => new Response(JSON.stringify({ results: [] }), { status: 200 });
    const res = await searxng.runSearxngSearch({ baseUrl: 'http://searxng.test', query: 'q', maxResults: 3, egressPolicy: policy(['searxng.test']) });
    assert.equal(res.success, true);
    assert.equal(calls[0]!.redirect, 'manual');
  });

  it('Tavily: refused when api.tavily.com is off the list; allowed when listed', async () => {
    await assert.rejects(
      () => tavily.runTavilySearch({ apiKey: 'k', query: 'q', maxResults: 3, egressPolicy: policy(['searxng.test']) }),
      shared.ToolEgressBlockedError,
    );
    assert.equal(calls.length, 0);
    respond = () => new Response(JSON.stringify({ results: [] }), { status: 200 });
    const ok = await tavily.runTavilySearch({ apiKey: 'k', query: 'q', maxResults: 3, egressPolicy: policy(['api.tavily.com']) });
    assert.equal(ok.success, true);
  });

  it('Tavily: a redirect off the list is refused', async () => {
    respond = (url) =>
      url.startsWith('https://api.tavily.com')
        ? new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/search' } })
        : new Response('{}');
    await assert.rejects(
      () => tavily.runTavilySearch({ apiKey: 'k', query: 'q', maxResults: 3, egressPolicy: policy(['api.tavily.com']) }),
      (err: unknown) => err instanceof shared.ToolEgressBlockedError && err.host === 'elsewhere.test',
    );
    assert.deepEqual(calls.map((c) => c.url), ['https://api.tavily.com/search']);
  });

  it('Nitter: the configured base URL is checked as written (other IP notations refused)', async () => {
    const client = new nitter.NitterClient('http://3405803783', policy(['203.0.113.7']));
    await assert.rejects(() => client.feedUser('someone'), shared.ToolEgressBlockedError);
    assert.equal(calls.length, 0);
  });

  it('Nitter: a redirect off the list is refused', async () => {
    respond = () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/rss' } });
    const client = new nitter.NitterClient('https://nitter.test', policy(['nitter.test']));
    await assert.rejects(
      () => client.feedUser('someone'),
      (err: unknown) => err instanceof shared.ToolEgressBlockedError && err.host === 'elsewhere.test',
    );
    assert.equal(calls.length, 1);
  });
});

describe('tool egress: route denial', () => {
  it('answers 403 and writes an agent.tool_denied row with the host only', async () => {
    const rows: Array<Record<string, unknown>> = [];
    egress.setToolEgressRecorderForTests(async (row) => {
      rows.push(row as Record<string, unknown>);
    });
    const res = await egress.handleToolEgressError(
      new shared.ToolEgressBlockedError('elsewhere.test'),
      { runCtx: { agentId: 'agent-1', companyId: 'company-1', runId: 'run-1' }, agentName: 'Agent 1' },
      'webSearchTavily',
    );
    assert.ok(res);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'tool_not_allowed');
    assert.equal(body.reason, 'egress_not_allowed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.action, 'agent.tool_denied');
    assert.deepEqual(rows[0]!.details, {
      tool: 'webSearchTavily',
      reason: 'egress_not_allowed',
      host: 'elsewhere.test',
      stage: 'request',
      runId: 'run-1',
    });
  });

  it('other errors fall through', async () => {
    assert.equal(await egress.handleToolEgressError(new Error('boom'), { runCtx: { agentId: 'a', companyId: 'c' } }, 't'), null);
  });

  it('a failing activity write still answers 403', async () => {
    egress.setToolEgressRecorderForTests(async () => {
      throw new Error('db down');
    });
    const res = await egress.handleToolEgressError(new shared.ToolEgressBlockedError(null), { runCtx: { agentId: 'a', companyId: 'c' } }, 't');
    assert.equal(res?.status, 403);
  });
});

describe('tool egress: settings form', () => {
  it('reads mode and one host per line (or comma-separated)', () => {
    const fd = new FormData();
    fd.set('toolEgressMode', 'list');
    fd.set('toolEgressEntries', 'search.example.com\n *.example.org , mcp.example.net:443\n\n');
    assert.deepEqual(form.parseToolEgressFormData(fd), {
      mode: 'list',
      entries: ['search.example.com', '*.example.org', 'mcp.example.net:443'],
    });
    const off = new FormData();
    off.set('toolEgressEntries', 'search.example.com');
    assert.equal(form.parseToolEgressFormData(off).mode, 'off');
  });

  it('save-time validation names the bad entry', () => {
    assert.throws(() => shared.resolveToolEgressAllowListInput('list', ['ok.example', 'https://bad.example/x']), /bad\.example.*not a URL/);
    assert.equal(shared.resolveToolEgressAllowListInput('off', ['ignored']), null);
  });
});
