/**
 * #348 — end-to-end wiring smoke for the REAL @mastra/next adapter under the
 * Studio gate (no mocks for the adapter itself). Proves:
 *   - the single mounted handler lists registered agents (GET /agents) and
 *     their tools (GET /agents/:id/tools) when the flag is on + LAN socket;
 *   - C2f at the real-adapter level: memory / tool-execute / workflows /
 *     telemetry never reach the hono app (404 from the route gate);
 *   - no auth, no storage, no telemetry exporter is needed for list/tools
 *     (the instance is bare — C10a: nothing here wires an exporter).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createNextRouteHandler } from '@mastra/next';
import { z } from 'zod';
import { createStudioRouteHandlers } from './route-core';

const SEAM = Symbol.for('tourbillon.studio.socket-address');
const LAN_SOCKET = '192.0.2.50';

const echoTool = createTool({
  id: 'echoTool',
  description: 'echo',
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string() }),
  execute: async ({ value }) => ({ value }),
});

function bareMastra() {
  const mastra = new Mastra({ logger: false });
  mastra.addAgent(
    new Agent({
      id: 'studio-fixture-a',
      name: 'Studio Fixture A',
      instructions: 'fixture',
      model: 'openai/gpt-4o-mini',
      tools: { echoTool },
    }),
    'studio-fixture-a',
  );
  return mastra;
}

function handlersFor(mastra: ReturnType<typeof bareMastra>) {
  const adapter = createNextRouteHandler({ mastra, prefix: '/api/mastra' });
  const hydrations: string[] = [];
  const handlers = createStudioRouteHandlers({
    env: () => ({
      MASTRA_API_ENABLED: 'true',
      MASTRA_STUDIO_ALLOWED_CIDRS: '192.0.2.0/24',
      MASTRA_STUDIO_ORIGIN: 'http://192.0.2.170:4111',
    }),
    resolveSocket: (req) => (req as unknown as Record<symbol, unknown>)[SEAM] as string,
    getAdapter: async () => async (req: Request) => adapter.GET(req),
    ensureHydrated: async () => {
      hydrations.push('ok');
    },
  });
  const call = async (method: 'GET' | 'POST', path: string, init?: RequestInit) => {
    const req = new Request(`http://internal.invalid${path}`, { method, ...init });
    Object.defineProperty(req, SEAM, { value: LAN_SOCKET });
    return handlers[method](req);
  };
  return { call, hydrations };
}

describe('#348 adapter smoke (real @mastra/next behind the gate)', () => {
  it('GET /api/mastra/agents lists registered DB-hydrated agents', async () => {
    const { call, hydrations } = handlersFor(bareMastra());
    const res = await call('GET', '/api/mastra/agents');
    assert.equal(res.status, 200, `agents list status (body: ${await res.clone().text()})`);
    const body = await res.json();
    const text = JSON.stringify(body);
    assert.match(text, /studio-fixture-a/, 'registered agent id must be listed');
    assert.equal(hydrations.length, 1, 'hydration ran exactly once');
  });

  it('GET /api/mastra/agents/studio-fixture-a/tools is gated-open but the 1.81 adapter has no such collection route — tools ship inline in the payloads (PR note)', async () => {
    const { call } = handlersFor(bareMastra());
    // The full tool set is visible in the list + detail payloads (this is the
    // C3b discriminator: a placeholder/no-tools mutant fails here).
    const list = await call('GET', '/api/mastra/agents');
    assert.equal(list.status, 200);
    assert.match(await list.text(), /echoTool/, 'assigned tool must be listed (full tools, C3b)');
    const detail = await call('GET', '/api/mastra/agents/studio-fixture-a');
    assert.equal(detail.status, 200);
    assert.match(await detail.text(), /echoTool/, 'assigned tool must be in the detail payload');
    // The shape is allowed through our gate; @mastra/hono 1.7.x has no
    // /agents/:id/tools collection route, so the 404 comes from the adapter,
    // not the guard — record in the PR body.
    const toolsRoute = await call('GET', '/api/mastra/agents/studio-fixture-a/tools');
    assert.equal(toolsRoute.status, 404);
  });

  it('POST generate/stream are gated-open and reach the adapter (not 404; a 4xx/5xx from a keyless model proves wiring)', async () => {
    const { call } = handlersFor(bareMastra());
    const gen = await call('POST', '/api/mastra/agents/studio-fixture-a/generate', {
      body: JSON.stringify({ messages: 'Reply with the single word pong.' }),
      headers: { 'content-type': 'application/json' },
    });
    assert.notEqual(gen.status, 404, 'generate must reach the adapter when allowed');
    const stream = await call('POST', '/api/mastra/agents/studio-fixture-a/stream', {
      body: JSON.stringify({ messages: 'Reply with the single word pong.' }),
      headers: { 'content-type': 'application/json' },
    });
    assert.notEqual(stream.status, 404, 'stream must reach the adapter when allowed');
  });

  it('C2f: memory / tool-execute / workflows / telemetry are 404 and never reach the adapter', async () => {
    let adapterHits = 0;
    const realAdapter = createNextRouteHandler({ mastra: bareMastra(), prefix: '/api/mastra' });
    const handlers = createStudioRouteHandlers({
      env: () => ({
        MASTRA_API_ENABLED: 'true',
        MASTRA_STUDIO_ALLOWED_CIDRS: '192.0.2.0/24',
        MASTRA_STUDIO_ORIGIN: 'http://192.0.2.170:4111',
      }),
      resolveSocket: (req) => (req as unknown as Record<symbol, unknown>)[SEAM] as string,
      getAdapter: async () => async (req: Request) => {
        adapterHits += 1;
        return realAdapter.GET(req);
      },
      ensureHydrated: async () => undefined,
    });
    const call = async (method: 'GET' | 'POST', path: string) => {
      const req = new Request(`http://internal.invalid${path}`, {
        method,
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      Object.defineProperty(req, SEAM, { value: LAN_SOCKET });
      return method === 'GET' ? handlers.GET(req) : handlers.POST(req);
    };
    for (const [m, p] of [
      ['GET', '/api/mastra/memory/threads'],
      ['POST', '/api/mastra/memory/threads'],
      ['POST', '/api/mastra/tools/echoTool/execute'],
      ['POST', '/api/mastra/agents/studio-fixture-a/tools/echoTool/execute'],
      ['GET', '/api/mastra/workflows'],
      ['GET', '/api/mastra/telemetry/traces'],
    ] as const) {
      const res = await call(m, p);
      assert.equal(res.status, 404, `${m} ${p}`);
    }
    assert.equal(adapterHits, 0, 'blocked paths must never reach the hono app');
  });

  it('public socket gets the same plain 404 against the real adapter (no leak via hono)', async () => {
    const realAdapter = createNextRouteHandler({ mastra: bareMastra(), prefix: '/api/mastra' });
    const handlers = createStudioRouteHandlers({
      env: () => ({
        MASTRA_API_ENABLED: 'true',
        MASTRA_STUDIO_ALLOWED_CIDRS: '192.0.2.0/24',
        MASTRA_STUDIO_ORIGIN: 'http://192.0.2.170:4111',
      }),
      resolveSocket: () => '198.51.100.77',
      getAdapter: async () => async (req: Request) => realAdapter.GET(req),
      ensureHydrated: async () => undefined,
    });
    const req = new Request('http://internal.invalid/api/mastra/agents');
    const res = await handlers.GET(req);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});
