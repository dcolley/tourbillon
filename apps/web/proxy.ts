import { NextResponse, type NextRequest } from 'next/server';
import { BOARD_SESSION_COOKIE, hasAgentToken, verifyBoardSessionToken } from './lib/board-auth';

/**
 * #105: board gate for the web UI (dashboard pages, server actions, /select-company, /bullmq).
 * API routes are excluded by the matcher; they gate themselves via getActiveCompanyOrNull /
 * verifyMobileToken / run tokens.
 *
 * Public (no session): GET/HEAD of the landing page and /unlock, plus the exact static files
 * named in the matcher. Everything else needs a valid signed board session cookie; agent run
 * tokens never count as board. Any request carrying a `Next-Action` header (a server action)
 * is gated on every path, including / and /unlock.
 */
const PUBLIC_PATHS = new Set(['/', '/unlock']);

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isServerAction = req.headers.has('next-action');
  const isRead = (req.method === 'GET' || req.method === 'HEAD') && !isServerAction;

  if (isRead && PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const isBoard =
    !hasAgentToken(req.headers.get('authorization')) &&
    (await verifyBoardSessionToken(req.cookies.get(BOARD_SESSION_COOKIE)?.value, req.headers));
  if (isBoard) return NextResponse.next();

  // Server actions / other writes: plain 401, no redirect.
  if (!isRead) return new NextResponse(null, { status: 401 });

  const url = req.nextUrl.clone();
  url.pathname = '/unlock';
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

/**
 * #105 B1: no extension-based exemption. A generic `.*\.(png|svg|…)$` exclusion let
 * `/agent/x.png` (a dynamic dashboard route) skip the proxy, including server-action POSTs.
 * Only these are exempt: /api (self-gated), Next build assets, favicon, the app icon
 * (app/icon.svg) and the real files in apps/web/public. Adding a file to public/ means adding
 * it here, otherwise it is board-gated (fails closed).
 * The second matcher gates every request with a `Next-Action` header, whatever the path.
 * Next requires this config to be statically analysable, so it stays a literal.
 */
export const config = {
  matcher: [
    '/((?!api/|api$|_next/static/|_next/image$|favicon\\.ico$|icon\\.svg$|logo\\.svg$|gears-working-cog-bronze-gear-mechanism-in-rim-mLskLLME\\.jpg$).*)',
    { source: '/:path*', has: [{ type: 'header', key: 'next-action' }] },
  ],
};
