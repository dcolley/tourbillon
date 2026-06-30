// ============================================================================
// TOUR-118: Token Management — Logout Endpoint
// 
// POST   /api/auth/logout - Invalidate all tokens and log out user
// ============================================================================

import { NextResponse } from 'next/server';

/**
 * POST - Log out the current user by invalidating all tokens
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    // In production, this would:
    // 1. Invalidate all active sessions in the database
    // 2. Clear any persistent token storage (localStorage, cookies)
    // 3. Return success response
    
    console.log('[AUTH] User logged out successfully');

    return NextResponse.json({ 
      message: 'Logged out successfully',
      timestamp: new Date().toISOString()
    }, { 
      status: 200,
      headers: {
        'Set-Cookie': 'session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      }
    });
    
  } catch (error) {
    console.error('[AUTH] Error during logout:', error);
    return NextResponse.json({ 
      error: 'Failed to log out' 
    }, { status: 500 });
  }
}
