import { NextResponse, type NextRequest } from 'next/server';
import { BOARD_SESSION_COOKIE, hasAgentToken, verifyBoardSessionToken } from './lib/board-auth';

/**
 * #105: board gate for the web UI (dashboard pages, server actions, /select-company, /bullmq).
 * API routes are excluded by the matcher; they gate themselves via getActiveCompanyOrNull /
 * verifyMobileToken / run tokens.
 *
 * Public (no session): GET/HEAD of the landing page, /unlock and /health (uptime probes), plus
 * static images (excluded by the matcher). Everything else needs a valid
 * signed board session cookie; agent run tokens never count as board.
 */
const PUBLIC_PATHS = new Set(['/', '/unlock', '/health']);

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (isRead && PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const isBoard =
    !hasAgentToken(req.headers.get('authorization')) &&
    (await verifyBoardSessionToken(req.cookies.get(BOARD_SESSION_COOKIE)?.value));
  if (isBoard) return NextResponse.next();

  // Server actions / other writes: plain 401, no redirect.
  if (!isRead) return new NextResponse(null, { status: 401 });

  const url = req.nextUrl.clone();
  url.pathname = '/unlock';
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
