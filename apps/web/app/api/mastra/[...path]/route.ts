/**
 * #348 — Mastra Studio API mount. The ONLY place the Mastra HTTP API is
 * exposed: the catch-all lives under app/api/mastra/, and route-core refuses
 * anything outside that prefix. The default @mastra/next prefix (/api) would
 * steal Tourbillon's /api/agents, /api/chat, /api/mcp families — never use it.
 *
 * proxy.ts exempts /api/* from the board cookie gate, so this route is fully
 * self-gated: flag → path allowlist → socket guard (see
 * lib/mastra-studio/route-core.ts). Do not add /mastra or /studio pages.
 */
import { createNextRouteHandler } from '@mastra/next';
// Relative import avoids the package barrel (same pattern as lib/chat/registry.ts).
import { getMastraInstance } from '../../../../../../packages/mastra/src/mastra-instance';
import {
  createStudioRouteHandlers,
  type StudioRouteDeps,
} from '../../../../lib/mastra-studio/route-core';
import { ensureStudioAgentsHydrated } from '../../../../lib/mastra-studio/hydration';
import { getCapturedSocketAddress } from '../../../../lib/mastra-studio/socket-capture';

export const dynamic = 'force-dynamic';

/**
 * Test seam: a Request carrying this symbol is treated as the socket holder.
 * Unit tests inject `{ [STUDIO_SOCKET_SEAM]: '192.0.2.5' }`-style fakes; a
 * real HTTP client cannot set a JS symbol on the server object.
 */
export const STUDIO_SOCKET_SEAM = Symbol.for('tourbillon.studio.socket-address');

/**
 * True transport address of the request — the guard's only source of truth.
 * Channel order:
 *   1. test seam (a JS symbol an HTTP client cannot set);
 *   2. the AsyncLocalStorage capture installed by instrumentation.ts — the
 *      value is read off Node's own socket object at 'request' dispatch;
 *   3. direct socket/originalRequest accessors, should a future Next expose
 *      them on the route-handler request.
 * Unknown shape ⇒ null ⇒ the guard fails closed (404). Headers (XFF,
 * X-Real-IP, Forwarded, X-Forwarded-Host) are NEVER consulted here.
 */
export function extractSocketRemoteAddress(req: Request): string | null {
  const anyReq = req as unknown as Record<string | symbol, unknown>;
  const seam = anyReq?.[STUDIO_SOCKET_SEAM];
  if (typeof seam === 'string') return seam;
  const captured = getCapturedSocketAddress();
  if (captured) return captured;
  const candidates: unknown[] = [
    (req as { socket?: { remoteAddress?: unknown } }).socket?.remoteAddress,
    (anyReq?.originalRequest as { socket?: { remoteAddress?: unknown } } | undefined)?.socket
      ?.remoteAddress,
    (anyReq?.[Symbol.for('next.originalRequest')] as
      | { socket?: { remoteAddress?: unknown } }
      | undefined)?.socket?.remoteAddress,
    (anyReq?.[Symbol.for('next.req')] as { socket?: { remoteAddress?: unknown } } | undefined)
      ?.socket?.remoteAddress,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

const globalForStudioRoute = globalForThis();
function globalForThis() {
  return globalThis as unknown as {
    tourbillonStudioAdapter?: Promise<(req: Request) => Promise<Response>>;
  };
}

function getAdapter(): Promise<(req: Request) => Promise<Response>> {
  if (!globalForStudioRoute.tourbillonStudioAdapter) {
    const handlers = createNextRouteHandler({
      mastra: getMastraInstance(),
      prefix: '/api/mastra',
    });
    // One handler function serves every method; normalize the sync Response
    // variant and keep a stable reference.
    globalForStudioRoute.tourbillonStudioAdapter = (async () => {
      const handler = handlers.GET;
      return async (req: Request) => handler(req);
    })();
  }
  return globalForStudioRoute.tourbillonStudioAdapter as Promise<
    (req: Request) => Promise<Response>
  >;
}

const deps: StudioRouteDeps = {
  env: () => process.env,
  resolveSocket: extractSocketRemoteAddress,
  getAdapter,
  ensureHydrated: () => ensureStudioAgentsHydrated(),
};

const handlers = createStudioRouteHandlers(deps);

export const GET = handlers.GET;
export const HEAD = handlers.HEAD;
export const POST = handlers.POST;
export const OPTIONS = handlers.OPTIONS;
export const PUT = handlers.PUT;
export const DELETE = handlers.DELETE;
export const PATCH = handlers.PATCH;
