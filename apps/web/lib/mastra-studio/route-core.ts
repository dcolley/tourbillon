/**
 * #348 — internal-only Mastra Studio route core.
 *
 * The whole decision pipeline for /api/mastra/* as a pure factory, so the
 * Next route file stays 3 lines of wiring and every gate is testable without
 * booting Next:
 *
 *   flag (exact 'true') → path allowlist → socket guard →
 *   hydration → adapter delegation (+ exact-origin CORS).
 *
 * Order matters: an unauthenticated public request only ever sees a plain
 * 404 — never a 401, never an ACAO, never a Mastra error body.
 */
import {
  decideStudioAccess,
  isMastraStudioApiEnabled,
  isStudioApiPathAllowed,
  studioCorsHeadersFor,
  studioPreflightHeaders,
  type StudioEnv,
} from '@tourbillon/shared/mastra-studio';

/** Catch-all mount. The unprefixed /api/* families belong to Tourbillon. */
export const STUDIO_API_PREFIX = '/api/mastra';

export interface StudioRouteDeps {
  /** Live env read (tests flip values per case). */
  env: () => StudioEnv;
  /**
   * True TCP socket remote address of THIS request. Implementations must read
   * the transport, never X-Forwarded-For / X-Real-IP / Forwarded /
   * X-Forwarded-Host. Returning null/undefined fails closed (404).
   */
  resolveSocket: (req: Request) => string | null | undefined;
  /** Lazily-built @mastra/next adapter over the single Mastra instance. */
  getAdapter: () => Promise<(req: Request) => Promise<Response>>;
  /** Register DB agents (full tools, CC-filtered) on the instance. */
  ensureHydrated: () => Promise<unknown>;
}

function headersToRecord(headers: Headers): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Generic 404 — no body that could confirm the mount, no CORS headers. */
function notFound(): Response {
  return new Response('404 — page could not be found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

const BODYLESS = new Set([204, 205, 304]);

/** Strip any upstream CORS headers, then apply the exact-origin allowlist. */
function withCors(upstream: Response, requestOrigin: string | null, env: StudioEnv): Response {
  const headers = new Headers(upstream.headers);
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase().startsWith('access-control-')) headers.delete(key);
  }
  const cors = studioCorsHeadersFor(requestOrigin, env);
  if (cors) {
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  }
  return new Response(BODYLESS.has(upstream.status) ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export interface StudioRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  HEAD: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
  PUT: (req: Request) => Promise<Response>;
  DELETE: (req: Request) => Promise<Response>;
  PATCH: (req: Request) => Promise<Response>;
  OPTIONS: (req: Request) => Promise<Response>;
}

export function createStudioRouteHandlers(deps: StudioRouteDeps): StudioRouteHandlers {
  async function handle(req: Request, method: string): Promise<Response> {
    const env = deps.env();

    // C1/C2 — off means every Studio path 404s before anything else runs
    // (no DB touch, no adapter build, no CORS advertisement).
    if (!isMastraStudioApiEnabled(env)) return notFound();

    let pathname: string;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      return notFound();
    }
    if (pathname !== STUDIO_API_PREFIX && !pathname.startsWith(`${STUDIO_API_PREFIX}/`)) {
      // Mounted outside its prefix — refuse rather than shadow Tourbillon /api/*.
      return notFound();
    }
    const relPath = pathname.slice(STUDIO_API_PREFIX.length + 1);

    // C2f — even with the flag on: agents list/detail/tools + generate/stream
    // only; memory, tool-execute, workflows, telemetry, everything else 404s.
    if (!isStudioApiPathAllowed(method, relPath)) return notFound();

    const headerRecord = headersToRecord(req.headers);

    // C5 — socket-only guard. Forged XFF/X-Real-IP/Forwarded/X-Forwarded-Host
    // and public Host headers all land in 404 (never a recovery of "LAN").
    const decision = decideStudioAccess(
      { socketRemoteAddress: deps.resolveSocket(req), headers: headerRecord },
      env,
    );
    if (!decision.allow) return notFound();

    const origin = req.headers.get('origin');

    // C6 — preflight only for the exact Studio origin(s); others get a plain 404.
    if (method === 'OPTIONS') {
      const preflight = studioPreflightHeaders(origin, env);
      if (!preflight) return notFound();
      return new Response(null, { status: 204, headers: preflight });
    }

    // No auth layer by design (final product ruling): the socket guard above
    // is the only access control. Requests reaching here are LAN/tailnet peers.

    try {
      await deps.ensureHydrated();
      const adapter = await deps.getAdapter();
      const upstream = await adapter(req);
      return withCors(upstream, origin, env);
    } catch {
      // Studio failures never leak internals; Tourbillon routes are untouched.
      return new Response('500 — studio unavailable', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  }

  const alwaysNotFound = async (): Promise<Response> => notFound();

  return {
    GET: (req) => handle(req, 'GET'),
    HEAD: (req) => handle(req, 'HEAD'),
    POST: (req) => handle(req, 'POST'),
    OPTIONS: (req) => handle(req, 'OPTIONS'),
    // The Studio surface is read + generate/stream only.
    PUT: alwaysNotFound,
    DELETE: alwaysNotFound,
    PATCH: alwaysNotFound,
  };
}
