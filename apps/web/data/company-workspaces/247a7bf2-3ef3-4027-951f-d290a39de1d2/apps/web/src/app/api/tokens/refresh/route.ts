// ============================================================================
// TOUR-118: Token Management — Refresh Endpoint
// 
// POST   /api/tokens/refresh - Refresh session/access tokens
// ============================================================================

import { NextResponse } from 'next/server';

interface ApiResponse {
  message?: string;
  error?: string;
  tokenType?: string;
  expiresIn?: number; // seconds until expiry
  newToken?: string; // only returned on successful refresh
}

/**
 * POST - Refresh tokens (session, access, or refresh)
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { tokenType }: { tokenType?: string } = body;

    // Validate input
    if (!tokenType || !['session', 'access', 'refresh'].includes(tokenType)) {
      return NextResponse.json({ 
        error: 'Invalid or missing token type. Must be one of: session, access, refresh' 
      }, { status: 400 });
    }

    // Generate new expiry times based on token type
    let expiresIn: number;
    switch (tokenType) {
      case 'session':
        expiresIn = 7200; // 2 hours
        break;
      case 'access':
        expiresIn = 86400; // 24 hours
        break;
      case 'refresh':
        expiresIn = 2592000; // 30 days
        break;
    }

    // Generate a new token (in production, this would update the database)
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let newToken = '';
    for (let i = 0; i < 48; i++) {
      newToken += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    console.log(`[TOKENS] Refreshed ${tokenType} token successfully`);

    return NextResponse.json({
      message: 'Tokens refreshed successfully',
      tokenType,
      expiresIn,
      newToken, // Only returned once during refresh
      timestamp: new Date().toISOString(),
    } as ApiResponse, { status: 200 });
    
  } catch (error) {
    console.error('[TOKENS] Error refreshing tokens:', error);
    return NextResponse.json({ 
      error: 'Failed to refresh tokens' 
    }, { status: 500 });
  }
}
