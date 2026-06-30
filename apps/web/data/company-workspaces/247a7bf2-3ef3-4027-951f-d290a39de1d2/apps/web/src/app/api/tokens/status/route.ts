// ============================================================================
// TOUR-118: Token Management — Status Check Endpoint
// 
// GET    /api/tokens/status - Check token health and expiry status
// ============================================================================

import { NextResponse } from 'next/server';

interface TokenStatus {
  type: string;
  isValid: boolean;
  expiresInMs: number; // time until expiry in milliseconds
  expiresAt: Date;
  autoRefreshAvailable: boolean;
  lastChecked: Date;
}

interface ApiResponse {
  status?: 'healthy' | 'warning' | 'critical';
  tokens?: TokenStatus[];
  recommendations?: string[];
  error?: string;
}

/**
 * GET - Check token health and expiry status
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const now = Date.now();
    
    // Mock token statuses based on wireframes
    const tokens: TokenStatus[] = [
      {
        type: 'Session',
        isValid: true,
        expiresInMs: 7200000, // 2 hours remaining
        expiresAt: new Date(now + 7200000),
        autoRefreshAvailable: true,
        lastChecked: new Date(),
      },
      {
        type: 'Access Token',
        isValid: true,
        expiresInMs: 35400000, // ~10 hours remaining
        expiresAt: new Date(now + 35400000),
        autoRefreshAvailable: false,
        lastChecked: new Date(),
      },
      {
        type: 'Refresh Token',
        isValid: true,
        expiresInMs: 2592000000, // 30 days remaining
        expiresAt: new Date(now + 2592000000),
        autoRefreshAvailable: false,
        lastChecked: new Date(),
      },
    ];

    // Determine overall status
    const minExpiry = Math.min(...tokens.map(t => t.expiresInMs));
    let status: 'healthy' | 'warning' | 'critical';
    if (minExpiry <= 0) {
      status = 'critical';
    } else if (minExpiry < 3600000) { // Less than 1 hour
      status = 'warning';
    } else {
      status = 'healthy';
    }

    const recommendations: string[] = [];
    
    // Add recommendations based on token status
    if (status === 'critical') {
      recommendations.push('Some tokens have expired. Please refresh or re-authenticate.');
    }
    
    if (tokens.some(t => t.expiresInMs < 3600000 && t.autoRefreshAvailable)) {
      recommendations.push('A token will expire within the hour. Consider refreshing it now.');
    }

    console.log('[TOKENS] Token status check completed - Status:', status);

    return NextResponse.json({ 
      status,
      tokens,
      recommendations: recommendations.length > 0 ? recommendations : undefined,
      timestamp: new Date().toISOString()
    } as ApiResponse);
    
  } catch (error) {
    console.error('[TOKENS] Error checking token status:', error);
    return NextResponse.json({ 
      error: 'Failed to check token status' 
    }, { status: 500 });
  }
}
