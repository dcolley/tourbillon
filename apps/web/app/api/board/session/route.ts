import { NextRequest, NextResponse } from 'next/server';
import {
  BOARD_SECRET_HEADER,
  BOARD_SESSION_COOKIE,
  BOARD_SESSION_TTL_SEC,
  boardSessionCookieOptions,
  createBoardSessionToken,
  hasAgentToken,
  isBoardAuthConfigured,
  verifyOperatorSecret,
} from '@/lib/board-auth';

function isHttps(req: NextRequest): boolean {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  return (proto ?? req.nextUrl.protocol.replace(':', '')) === 'https';
}

/**
 * POST /api/board/session
 * #105: unlock the web UI with the operator secret (X-Board-Secret header or JSON { secret }).
 * Issues a signed, httpOnly, short-lived board session cookie.
 */
export async function POST(req: NextRequest) {
  if (hasAgentToken(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Agents cannot open a board session' }, { status: 403 });
  }
  if (!isBoardAuthConfigured(req.headers)) {
    console.warn('Board session: TOURBILLON_BOARD_SECRET is not set; refusing to unlock');
    return new NextResponse(null, { status: 401 });
  }

  let presented = req.headers.get(BOARD_SECRET_HEADER);
  if (!presented) {
    try {
      const body = (await req.json()) as { secret?: unknown };
      presented = typeof body?.secret === 'string' ? body.secret : null;
    } catch {
      presented = null;
    }
  }
  if (!verifyOperatorSecret(presented, req.headers)) {
    return new NextResponse(null, { status: 401 });
  }

  const token = await createBoardSessionToken(req.headers);
  if (!token) return new NextResponse(null, { status: 401 });

  const expiresAt = new Date(Date.now() + BOARD_SESSION_TTL_SEC * 1000).toISOString();
  const res = NextResponse.json({ ok: true, expiresAt });
  res.cookies.set(BOARD_SESSION_COOKIE, token, boardSessionCookieOptions(isHttps(req)));
  return res;
}

/** DELETE /api/board/session: lock the web UI (clear the board session cookie). */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(BOARD_SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
