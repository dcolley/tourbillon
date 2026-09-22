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

export async function GET(req: NextRequest) {
  try {
    // Create a Request object for better-auth session check
    const authRequest = new Request(`${process.env.BETTER_AUTH_URL}/api/auth/session`, {
      method: 'GET',
      headers: req.headers,
    });

    // Get session from better-auth
    const authResponse = await auth.handler(authRequest);
    const result = await authResponse.json();

    // Check if session is valid
    if (authResponse.status === 200 && result.user && result.session) {
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

    // No valid session
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
