/**
 * Optimized Session Verification Endpoint - Using PostgreSQL with Async Queries
 * 
 * This file replaces the synchronous session verification implementation
 * with async database queries and connection pooling.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db, findActiveSession } from '@tourbillon/db';

export async function GET(request: NextRequest) {
  try {
    const cookieStore = cookies();
    const sessionToken = cookieStore.get('session');

    if (!sessionToken || !sessionToken.value) {
      return NextResponse.json(
        { error: 'No active session', isAuthenticated: false },
        { status: 401 }
      );
    }

    // Verify token and get user from database using indexed lookup
    const session = await findActiveSession(sessionToken.value);
    
    if (!session) {
      return NextResponse.json(
        { error: 'Invalid or expired session', isAuthenticated: false },
        { status: 401 }
      );
    }

    // Return user info without sensitive data (no password hash)
    const userInfo = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name || null,
      provider: session.user.provider || 'email',
    };

    return NextResponse.json({
      message: 'Session verified',
      isAuthenticated: true,
      user: userInfo,
    });
  } catch (error) {
    console.error('Session check error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
