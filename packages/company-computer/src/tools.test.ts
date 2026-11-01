/**
 * Toolset registration + call-shape tests with a stubbed fetch (no HTTP server).
 * Gate/HTTP errors from the API must reach the agent verbatim.
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { COMPANY_COMPUTER_TOOLS } from './tools';

type FakeCtx = { get: (k: string) => unknown };
const requestContext: FakeCtx = {
  get: (k: string) =>
    (({ apiKey: 'tok', runId: 'run-1', agentId: 'agent-1', companyId: 'comp-1' }) as Record<string, unknown>)[k],
};

interface Recorded { url: string; init?: RequestInit }
let recorded: Recorded[] = [];
let reply: { status: number; body: string } = { status: 200, body: '{}' };
const realFetch = globalThis.fetch;

before(() => {
  process.env.INTERNAL_API_URL = 'http://internal.test:3002';
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    recorded.push({ url: String(url), init });
    return new Response(reply.body, {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  delete process.env.INTERNAL_API_URL;
});

function tool(mapKey: string) {
  const t = (COMPANY_COMPUTER_TOOLS as Record<string, { id: string; execute: (i: unknown, o: { requestContext: unknown }) => Promise<unknown> }>)[mapKey];
  assert.ok(t, `tool ${mapKey} registered`);
  assert.equal(t.id, mapKey.replace(/Tool$/, ''), 'tool id drops the Tool suffix');
  return t;
}

describe('company-computer toolset registration', () => {
  it('registers the six implemented tools and five Slice-2 stubs', () => {
    assert.deepEqual(
      Object.keys(COMPANY_COMPUTER_TOOLS).sort(),
      [
        'computerClickTool',
        'computerCloseSessionTool',
        'computerGetSessionInfoTool',
        'computerMouseMoveTool',
        'computerOpenBrowserTool',
        'computerOpenFileManagerTool',
        'computerOpenTerminalTool',
        'computerPressKeyTool',
        'computerScreenshotTool',
        'computerScrollTool',
        'computerTypeTextTool',
      ].sort(),
    );
  });
});

describe('implemented tools call /api/internal/company-computer/<action>', () => {
  it('openBrowser POSTs the url', async () => {
    recorded = [];
    reply = { status: 200, body: JSON.stringify({ sessionId: 's1' }) };
    const out = await tool('computerOpenBrowserTool').execute({ url: 'https://example.com' }, { requestContext });
    assert.deepEqual(out, { sessionId: 's1' });
    assert.equal(recorded[0].url, 'http://internal.test:3002/api/internal/company-computer/openBrowser');
    assert.equal(recorded[0].init?.method, 'POST');
    assert.match(String(recorded[0].init?.body), /https:\/\/example\.com/);
  });

  it('click POSTs coordinates and button', async () => {
    recorded = [];
    reply = { status: 200, body: '{"success":true}' };
    const out = await tool('computerClickTool').execute({ x: 10, y: 20, button: 'left' }, { requestContext });
    assert.deepEqual(out, { success: true });
    assert.equal(recorded[0].url, 'http://internal.test:3002/api/internal/company-computer/click');
    assert.deepEqual(JSON.parse(String(recorded[0].init?.body)), { x: 10, y: 20, button: 'left' });
  });

  it('screenshot, typeText, closeSession, getSessionInfo hit their actions', async () => {
    reply = { status: 200, body: '{"ok":true}' };
    for (const [id, action] of [
      ['computerScreenshotTool', 'screenshot'],
      ['computerCloseSessionTool', 'destroySession'],
      ['computerGetSessionInfoTool', 'getSession'],
    ] as const) {
      recorded = [];
      await tool(id).execute({}, { requestContext });
      assert.ok(recorded[0].url.endsWith(`/api/internal/company-computer/${action}`), id);
    }
    recorded = [];
    await tool('computerTypeTextTool').execute({ text: 'hello' }, { requestContext });
    assert.ok(recorded[0].url.endsWith('/api/internal/company-computer/typeText'));
  });

  it('gate errors from the API pass through verbatim (403 body preserved)', async () => {
    recorded = [];
    reply = {
      status: 403,
      body: '{"error":"agent_no_computer","message":"Agent does not have Computer access. Ask Board to enable hasComputer on the agent detail page."}',
    };
    const out = (await tool('computerScreenshotTool').execute({}, { requestContext })) as {
      error: string;
      message: string;
    };
    assert.equal(out.error, 'HTTP 403');
    assert.match(out.message, /Agent does not have Computer access/);
  });

  it('openBrowser schema rejects non-http(s) urls', () => {
    type ToolWithSchema = { inputSchema: { safeParse: (v: unknown) => { success: boolean } } };
    const t = (COMPANY_COMPUTER_TOOLS as Record<string, ToolWithSchema>).computerOpenBrowserTool;
    assert.equal(t.inputSchema.safeParse({ url: 'file:///etc/passwd' }).success, false);
    assert.equal(t.inputSchema.safeParse({ url: 'javascript:alert(1)' }).success, false);
    assert.equal(t.inputSchema.safeParse({ url: 'https://ok.example' }).success, true);
    assert.equal(t.inputSchema.safeParse({}).success, true, 'url is optional');
  });
});

describe('Slice-2 stubs answer not_implemented without touching the network', () => {
  for (const [mapKey, input] of [
    ['computerOpenFileManagerTool', { path: '/data' }],
    ['computerOpenTerminalTool', { cwd: '/home/kasm-user' }],
    ['computerPressKeyTool', { key: 'Enter' }],
    ['computerMouseMoveTool', { x: 0, y: 0 }],
    ['computerScrollTool', { direction: 'down' }],
  ] as const) {
    it(`${mapKey} -> { error: 'not_implemented' }`, async () => {
      recorded = [];
      const out = (await tool(mapKey).execute(input, { requestContext })) as { error: string };
      assert.equal(out.error, 'not_implemented');
      assert.deepEqual(recorded, [], 'stubs must not call the API');
    });
  }
});
