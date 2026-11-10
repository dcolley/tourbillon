/**
 * #348 route-level integration tests for the Studio handler pipeline
 * (route-core) — C2 (404 matrix, off), C2f (404 surface, on), C5h (socket
 * source-of-truth at the route seam), C6 (CORS on the wire),
 * no-auth ruling (no token/basic-auth anywhere),
 * plus C2e/C7b static guards proving Tourbillon routes stay untouched.
 *
 * The socket address is injected through the same seam the production route
 * exposes (a JS symbol the HTTP client cannot set) — headers are always set
 * separately, pinning "socket, never headers" per C5h.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createStudioRouteHandlers } from './route-core';

const SEAM = Symbol.for('tourbillon.studio.socket-address');

const LAN = '192.0.2.0/24'; // RFC 5737 stand-in for <lan-cidr>
const LAN_SOCKET = '192.0.2.50';
const PUBLIC_SOCKET = '198.51.100.77';
const PROXY_SOCKET = '198.51.100.9';
const STUDIO_ORIGIN = 'http://192.0.2.170:4111';
const ID = '9f1c2b3a-0000-4000-8000-abcdef012345';

const BASE_ENV: Record<string, string> = {
  MASTRA_STUDIO_ALLOWED_CIDRS: LAN,
  MASTRA_STUDIO_TRUSTED_PROXY: PROXY_SOCKET,
  MASTRA_STUDIO_PUBLIC_HOSTS: 'studio-public.example',
  MASTRA_STUDIO_ORIGIN: STUDIO_ORIGIN,
};

interface Setup {
  call: (
    method: string,
    url: string,
    opts?: { socket?: string | null; headers?: Record<string, string>; body?: string },
  ) => Promise<Response>;
  adapterCalls: string[];
  hydrations: () => number;
}

function setup(opts?: { env?: Record<string, string | undefined>; adapterResponse?: () => Response }): Setup {
  const env: Record<string, string | undefined> = {
    MASTRA_API_ENABLED: 'true',
    ...BASE_ENV,
    ...(opts?.env ?? {}),
  };
  const adapterCalls: string[] = [];
  let hydrations = 0;
  const handlers = createStudioRouteHandlers({
    env: () => env,
    resolveSocket: (req) => (req as unknown as Record<symbol, unknown>)[SEAM] as string | undefined,
    getAdapter: async () => async (req: Request) => {
      adapterCalls.push(`${req.method} ${new URL(req.url).pathname}`);
      return (
        opts?.adapterResponse?.() ??
        new Response(JSON.stringify({ agents: [{ id: ID, name: 'fixture-agent' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    },
    ensureHydrated: async () => {
      hydrations += 1;
    },
  });
  return {
    async call(method, url, callOpts) {
      const req = new Request(`http://internal.invalid${url}`, {
        method,
        headers: callOpts?.headers ?? {},
        body: method === 'GET' || method === 'HEAD' ? undefined : callOpts?.body,
      });
      if (callOpts && 'socket' in callOpts) {
        Object.defineProperty(req, SEAM, { value: callOpts.socket });
      } else {
        Object.defineProperty(req, SEAM, { value: LAN_SOCKET });
      }
      const handler =
        method === 'GET'
          ? handlers.GET
          : method === 'HEAD'
            ? handlers.HEAD
            : method === 'POST'
              ? handlers.POST
              : method === 'OPTIONS'
                ? handlers.OPTIONS
                : method === 'PUT'
                  ? handlers.PUT
                  : method === 'DELETE'
                    ? handlers.DELETE
                    : handlers.PATCH;
      return handler(req);
    },
    adapterCalls,
    hydrations: () => hydrations,
  };
}

/** Every contract §2.2 inventory path (mount, extended, unprefixed, other prefixes). */
const INVENTORY = [
  '/api/mastra',
  '/api/mastra/',
  '/api/mastra/agents',
  `/api/mastra/agents/${ID}`,
  `/api/mastra/agents/${ID}/tools`,
  `/api/mastra/agents/${ID}/tools/some-tool/execute`,
  `/api/mastra/agents/${ID}/generate`,
  `/api/mastra/agents/${ID}/stream`,
  '/api/mastra/workflows',
  '/api/mastra/memory',
  '/api/mastra/memory/threads',
  '/api/mastra/tools',
  '/api/mastra/tools/some-tool/execute',
  '/api/mastra/telemetry',
  '/api/mastra/telemetry/traces',
  '/api/mastra/stored/workflows',
  '/api/mastra/knowledge',
  '/api/mastra/vectors',
  '/api/mastra/datasets',
  '/api/mastra/experiments',
  '/api/mastra/scores',
  '/api/mastra/mcp',
  '/api/mastra/logs',
  '/api/mastra/v1/responses',
  '/api/mastra/v1/conversations',
  '/api/workflows',
  '/api/memory',
  '/api/memory/threads',
  '/api/tools',
  '/api/telemetry',
  '/api/telemetry/traces',
  '/mastra',
  '/mastra/agents',
  '/studio',
  '/studio/',
];

describe('#348 C2 — flag OFF: 404 everywhere, nothing leaks', () => {
  for (const offValue of [undefined, '', 'false', '0', 'TRUE', '1', 'yes', 'ture']) {
    it(`every inventory path is 404 with MASTRA_API_ENABLED=${JSON.stringify(offValue)} (GET and POST)`, async () => {
      const s = setup({ env: { MASTRA_API_ENABLED: offValue } });
      for (const p of INVENTORY) {
        for (const method of ['GET', 'POST', 'OPTIONS'] as const) {
          const res = await s.call(method, p, {
            socket: LAN_SOCKET,
            headers: { host: '192.0.2.170:3002' },
            body: '{"messages":"pong"}',
          });
          assert.equal(res.status, 404, `${method} ${p} must 404 with flag off`);
          assert.equal(res.headers.get('access-control-allow-origin'), null, `${method} ${p} leaked ACAO`);
          assert.doesNotMatch(res.headers.get('vary') ?? '', /Origin/, 'no CORS behaviour advertised when off');
        }
      }
      assert.deepEqual(s.adapterCalls, [], 'adapter must never run with the flag off');
      assert.equal(s.hydrations(), 0, 'no DB hydration with the flag off');
    });
  }

  it('C2d: POST generate / tool execute are 404 — never 405 from a half-mounted handler', async () => {
    const s = setup({ env: { MASTRA_API_ENABLED: undefined } });
    const gen = await s.call('POST', `/api/mastra/agents/${ID}/generate`, { body: '{}' });
    const exec = await s.call('POST', '/api/mastra/tools/some-tool/execute', { body: '{}' });
    assert.equal(gen.status, 404);
    assert.equal(exec.status, 404);
  });
});

describe('#348 flag ON — path surface + guard at the route', () => {
  it('allowed surface delegates to the adapter after hydration', async () => {
    const s = setup();
    for (const p of ['/api/mastra/agents', `/api/mastra/agents/${ID}`, `/api/mastra/agents/${ID}/tools`]) {
      const res = await s.call('GET', p);
      assert.equal(res.status, 200, p);
    }
    const gen = await s.call('POST', `/api/mastra/agents/${ID}/generate`, { body: '{"messages":"pong"}' });
    assert.equal(gen.status, 200);
    const stream = await s.call('POST', `/api/mastra/agents/${ID}/stream`, { body: '{"messages":"pong"}' });
    assert.equal(stream.status, 200);
    assert.equal(s.hydrations(), 5);
    assert.equal(s.adapterCalls.length, 5);
  });

  it('C2f (route level): memory + tool-execute + other families are 404 even with the flag ON, adapter untouched', async () => {
    const s = setup();
    for (const p of [
      '/api/mastra/memory',
      '/api/mastra/memory/threads',
      '/api/mastra/tools',
      '/api/mastra/tools/some-tool/execute',
      `/api/mastra/agents/${ID}/tools/some-tool/execute`,
      '/api/mastra/workflows',
      '/api/mastra/telemetry',
      '/api/mastra/telemetry/traces',
      '/api/mastra/logs',
      '/api/mastra/v1/responses',
      '/api/mastra', // mount root itself is not an exposed surface
    ]) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await s.call(method, p, { body: '{}' });
        assert.equal(res.status, 404, `${method} ${p}`);
      }
    }
    assert.deepEqual(s.adapterCalls, [], 'forbidden paths must never reach the adapter');
  });

  it('C2b (mount safety): unprefixed Mastra paths 404 even with the flag ON (never mounted at /api)', async () => {
    const s = setup();
    for (const p of ['/api/workflows', '/api/memory', '/api/tools', '/api/telemetry', '/mastra', '/studio']) {
      const res = await s.call('GET', p);
      assert.equal(res.status, 404, p);
    }
    assert.deepEqual(s.adapterCalls, []);
  });

  it('case variants 404 (C4c defence-in-depth) — prefix match is case-sensitive', async () => {
    const s = setup();
    for (const p of ['/API/MASTRA/agents', '/api/Mastra/agents', '/Api/Mastra/agents']) {
      const res = await s.call('GET', p);
      assert.equal(res.status, 404, p);
    }
  });

  it('PUT/DELETE/PATCH 404 without any work', async () => {
    const s = setup();
    for (const method of ['PUT', 'DELETE', 'PATCH'] as const) {
      const res = await s.call(method, `/api/mastra/agents/${ID}/generate`);
      assert.equal(res.status, 404, method);
    }
    assert.deepEqual(s.adapterCalls, []);
  });

  it('C5h (route pin): socket, never headers — header-only LAN claims from 127.0.0.1/proxy/public all 404; missing socket 404s', async () => {
    const s = setup();
    const spoof = { 'x-forwarded-for': '192.0.2.50', 'x-real-ip': '192.0.2.50', 'x-forwarded-host': '192.0.2.170:3002' };
    for (const socket of ['127.0.0.1', PROXY_SOCKET, PUBLIC_SOCKET]) {
      const res = await s.call('GET', '/api/mastra/agents', { socket, headers: spoof });
      assert.equal(res.status, 404, `socket ${socket} with LAN-claiming headers`);
    }
    const noSocket = await s.call('GET', '/api/mastra/agents', { socket: undefined });
    assert.equal(noSocket.status, 404, 'no socket fails closed');
    assert.deepEqual(s.adapterCalls, []);
  });

  it('public Host header 404s even from a LAN socket (C5d/§2.1.3)', async () => {
    const s = setup();
    const res = await s.call('GET', '/api/mastra/agents', {
      socket: LAN_SOCKET,
      headers: { host: 'studio-public.example' },
    });
    assert.equal(res.status, 404);
  });

  it('LAN and Tailscale sockets are served; foreign sockets are 404', async () => {
    const s = setup();
    for (const socket of [LAN_SOCKET, '100.96.10.11', '127.0.0.1', '::ffff:192.0.2.77']) {
      const res = await s.call('GET', '/api/mastra/agents', { socket });
      assert.equal(res.status, 200, `socket ${socket}`);
    }
    for (const socket of [PUBLIC_SOCKET, '8.8.8.8', '::ffff:8.8.8.8', '203.0.113.9']) {
      const res = await s.call('GET', '/api/mastra/agents', { socket });
      assert.equal(res.status, 404, `socket ${socket}`);
    }
  });
});

describe('#348 C6 — CORS on the wire', () => {
  it('C6a/C6b: preflight 204 with exact ACAO/Vary/methods; GET carries ACAO too', async () => {
    const s = setup();
    const pre = await s.call('OPTIONS', '/api/mastra/agents', {
      headers: { origin: STUDIO_ORIGIN, 'access-control-request-method': 'GET' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), STUDIO_ORIGIN);
    assert.equal(pre.headers.get('vary'), 'Origin');
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /GET/);
    const get = await s.call('GET', '/api/mastra/agents', { headers: { origin: STUDIO_ORIGIN } });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('access-control-allow-origin'), STUDIO_ORIGIN);
    assert.equal(get.headers.get('access-control-allow-credentials'), null);
  });

  it('C6c/C6d/C6g: disallowed origins → served without ACAO (GET) or 404 (preflight); null gets nothing', async () => {
    const s = setup();
    for (const origin of [
      'https://evil.example',
      'null',
      'http://192.0.2.170.evil.example:4111',
      'http://evil-192.0.2.170:4111',
      'http://192.0.2.170:41110',
      'https://192.0.2.170:4111',
      'http://100.96.10.11:4111', // Tailscale origin not allowlisted here
    ]) {
      const res = await s.call('GET', '/api/mastra/agents', { headers: { origin } });
      assert.equal(res.status, 200, 'LAN GET still succeeds (C6c)');
      assert.equal(res.headers.get('access-control-allow-origin'), null, `${origin} leaked ACAO`);
      const pre = await s.call('OPTIONS', '/api/mastra/agents', { headers: { origin } });
      assert.equal(pre.status, 404, `${origin} preflight must not succeed`);
    }
  });

  it('C6e: a wildcard ACAO from the adapter is stripped; no response ever shows *', async () => {
    const s = setup({
      adapterResponse: () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
            'access-control-allow-credentials': 'true',
          },
        }),
    });
    const res = await s.call('GET', '/api/mastra/agents', { headers: { origin: STUDIO_ORIGIN } });
    assert.equal(res.headers.get('access-control-allow-origin'), STUDIO_ORIGIN);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });
});

describe('#348 no-auth ruling — Studio ships NO auth layer', () => {
  // Final product ruling (PM 15:58): the network guard is the only access
  // control. If a token/basic-auth path ever creeps back in, these fail.
  const WEB_ROOT = join(process.cwd());
  const files = [
    join(WEB_ROOT, 'lib/mastra-studio/route-core.ts'),
    join(WEB_ROOT, 'lib/mastra-studio/hydration.ts'),
    join(WEB_ROOT, 'app/api/mastra/[...path]/route.ts'),
    join(WEB_ROOT, '../../packages/shared/src/mastra-studio.ts'),
  ];

  it('studio sources reference no token env var and never emit 401', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      assert.ok(!/MASTRA_STUDIO_TOKEN/.test(src), `${f} still mentions MASTRA_STUDIO_TOKEN`);
      assert.ok(!/studioToken/.test(src), `${f} still mentions studioToken helpers`);
      assert.ok(!/status: 401/.test(src), `${f} still returns 401`);
      assert.ok(!/401 —/.test(src), `${f} still returns a 401 body`);
    }
  });

  it('LAN requests are unauthenticated end to end (documented side effect)', async () => {
    const s = setup();
    const res = await s.call('GET', '/api/mastra/agents');
    assert.equal(res.status, 200, 'no credential needed from a LAN socket');
    assert.equal(res.headers.get('www-authenticate'), null);
  });
});

describe('#348 C2e/C7b — Tourbillon routes untouched (static guards)', () => {
  const WEB_ROOT = join(process.cwd());

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
  }

  it('only the Studio mount + lib reference the studio modules (no other route wired)', () => {
    const offenders: string[] = [];
    for (const file of [...walk(join(WEB_ROOT, 'app')), ...walk(join(WEB_ROOT, 'lib'))]) {
      const src = readFileSync(file, 'utf8');
      const touches =
        src.includes('route-core') || src.includes('mastra-studio') || src.includes('mastra-instance');
      if (!touches) continue;
      const rel = file.slice(WEB_ROOT.length + 1).replace(/\\/g, '/');
      const allowed =
        rel === 'app/api/mastra/[...path]/route.ts' ||
        rel.startsWith('lib/mastra-studio/');
      if (!allowed) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], 'studio code must live only under its own mount + lib');
  });

  it('there is exactly ONE studio mount file and no /mastra or /studio page (C2b/C2c)', () => {
    const routeFile = join(WEB_ROOT, 'app/api/mastra/[...path]/route.ts');
    assert.ok(statSync(routeFile).isFile());
    const appDir = join(WEB_ROOT, 'app');
    const offenders: string[] = [];
    for (const file of walk(appDir)) {
      const rel = file.slice(appDir.length + 1);
      if (/^mastra(\/|$)/.test(rel) || /^studio(\/|$)/.test(rel)) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], 'no top-level /mastra or /studio app routes may exist');
  });

  it('C7c pin: the board proxy still exempts /api/* (Studio rides that exemption; matcher unchanged)', () => {
    const src = readFileSync(join(WEB_ROOT, 'proxy.ts'), 'utf8');
    assert.ok(
      src.includes('(?!api/|api$'),
      'proxy matcher must keep exempting /api/* — and nothing under /api bypasses the studio guard',
    );
    assert.ok(!src.includes('mastra'), 'proxy.ts must not special-case studio paths');
  });

  it('C9/C10: studio code never touches CC start or telemetry exporters', () => {
    const forbidden = [
      'CC_ALLOW_START', // C9: studio must not be able to start Company Computer seats
      'DefaultExporter',
      'MastraStorageExporter',
      'CloudExporter',
      'ArizeExporter',
      'TourbillonPostgresExporter',
      'buildExporters',
      'observability',
    ];
    const files = [
      join(WEB_ROOT, 'app/api/mastra/[...path]/route.ts'),
      join(WEB_ROOT, 'lib/mastra-studio/route-core.ts'),
      join(WEB_ROOT, 'lib/mastra-studio/hydration.ts'),
      join(WEB_ROOT, 'lib/mastra-studio/socket-capture.ts'),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const token of forbidden) {
        assert.ok(
          !src.includes(token),
          `${f.slice(WEB_ROOT.length + 1)} must not reference ${token}`,
        );
      }
    }
  });
});
