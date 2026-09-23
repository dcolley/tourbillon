/**
 * GET /api/auth/session
 * Check current session status
 * 
 * Accepts: Session cookie or Authorization: Bearer <token> header
 * Success: { authenticated: true, user: { id: string, email: string } }
 * No session: { authenticated: false }
 * Status codes: 200 (session exists), 401 (no session or invalid)
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db, eq, or, session, user } from '@tourbillon/db';

export async function GET(req: NextRequest) {
  try {
    // Check for Bearer token authentication
    const authHeader = req.headers.get('authorization');
    if (authHeader?.toLowerCase().startsWith('bearer ')) {
      const token = authHeader.substring(7).trim();
      
      if (!token) {
        return NextResponse.json(
          { 
            authenticated: false,
            error: 'No active session'
          },
          { status: 401 }
        );
      }

      // Query database for session by token or id
      const sessionRecord = await db
        .select({
          sessionId: session.id,
          sessionToken: session.token,
          sessionExpiresAt: session.expiresAt,
          userId: user.id,
          userEmail: user.email,
          userName: user.name,
        })
        .from(session)
        .innerJoin(user, eq(session.userId, user.id))
        .where(
          or(
            eq(session.token, token),
            eq(session.id, token)
          )
        )
        .limit(1);

      if (sessionRecord.length === 0) {
        return NextResponse.json(
          { 
            authenticated: false,
            error: 'No active session'
          },
          { status: 401 }
        );
      }

      const sessionData = sessionRecord[0];

      // Fail closed: reject sessions without expiration or past expiration
      if (!sessionData.sessionExpiresAt || new Date(sessionData.sessionExpiresAt) <= new Date()) {
        return NextResponse.json(
          { 
            authenticated: false,
            error: 'No active session'
          },
          { status: 401 }
        );
      }

      // Session is valid
      return NextResponse.json(
        {
          authenticated: true,
          user: {
            id: sessionData.userId,
            email: sessionData.userEmail,
            name: sessionData.userName,
          },
        },
        { status: 200 }
      );
    }

    // Fall back to cookie-based authentication via better-auth
    const authRequest = new Request(`${process.env.BETTER_AUTH_URL}/api/auth/get-session`, {
      method: 'GET',
      headers: req.headers,
    });

    const authResponse = await auth.handler(authRequest);
    
    let result;
    try {
      const text = await authResponse.text();
      result = text ? JSON.parse(text) : null;
    } catch {
      result = null;
    }

    if (authResponse.status === 200 && result?.user) {
      return NextResponse.json(
        {
          authenticated: true,
          user: {
            id: result.user.id,
            email: result.user.email,
            name: result.user.name,
          },
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { 
        authenticated: false,
        error: 'No active session'
      },
      { status: 401 }
    );

  } catch (error) {
    console.error('Session check error:', error);
    return NextResponse.json(
      { 
        authenticated: false,
        error: 'Session validation failed'
      },
      { status: 401 }
    );
  }
}
