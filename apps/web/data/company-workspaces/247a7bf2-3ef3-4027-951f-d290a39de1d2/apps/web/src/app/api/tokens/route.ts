// ============================================================================
// TOUR-118: Token Management — Session Info Endpoint
// 
// GET    /api/tokens - Get current session token information
// ============================================================================

import { NextResponse } from 'next/server';

interface TokenInfo {
  type: string; // session, access, refresh
  issuedAt: Date;
  expiresAt: Date;
  expiresInMs: number; // time until expiry in milliseconds
  status: 'valid' | 'expiring_soon' | 'expired';
  lastRefresh?: Date;
}

interface ApiResponse {
  tokens?: TokenInfo[];
  error?: string;
  sessionId?: string;
  userId?: string;
}

/**
 * GET - Get current session token information
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    // In production, this would fetch from database/auth service
    // For now, return mock data based on wireframes
    
    const now = Date.now();
    
    // Mock token data - in reality these would come from auth context
    const tokens: TokenInfo[] = [
      {
        type: 'Session',
        issuedAt: new Date(now - 3600000), // 1 hour ago
        expiresAt: new Date(now + 7200000), // 2 hours from now
        expiresInMs: 7200000,
        status: 'valid',
      },
      {
        type: 'Access Token',
        issuedAt: new Date(now - 600000), // 10 minutes ago
        expiresAt: new Date(now + 35400000), // ~10 hours from now
        expiresInMs: 35400000,
        status: 'valid',
      },
      {
        type: 'Refresh Token',
        issuedAt: new Date(now - 86400000), // 1 day ago
        expiresAt: new Date(now + 2592000000), // 30 days from now
        expiresInMs: 2592000000,
        status: 'valid',
      },
    ];

    console.log('[TOKENS] Retrieved session token information');

    return NextResponse.json({ 
      tokens,
      sessionId: 'session_' + Math.random().toString(36).substring(7),
      userId: 'user_current' // Would be actual user ID in production
    } as ApiResponse);
    
  } catch (error) {
    console.error('[TOKENS] Error fetching token info:', error);
    return NextResponse.json({ 
      error: 'Failed to fetch token information' 
    }, { status: 500 });
  }
}
