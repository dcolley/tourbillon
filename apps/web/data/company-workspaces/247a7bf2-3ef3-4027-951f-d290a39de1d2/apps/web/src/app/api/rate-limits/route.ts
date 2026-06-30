// ============================================================================
// TOUR-128: Rate Limits API - Usage Data Endpoint
// 
// GET    /api/rate-limits - Get current rate limit usage and status
// ============================================================================

import { NextResponse } from 'next/server';

interface RateLimitUsage {
  requestsThisHour: number;
  requestsPerHourLimit: number;
  requestsToday: number;
  requestsPerDayLimit: number;
  lastReset: Date;
  nextReset: Date;
}

interface EndpointUsage {
  endpoint: string;
  method: string;
  used: number;
  limit: number;
  resetAt: Date;
}

interface ApiResponse {
  usage?: RateLimitUsage;
  endpoints?: EndpointUsage[];
  planType?: 'free' | 'pro' | 'enterprise';
  error?: string;
}

/**
 * GET - Get current rate limit usage and status
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    // In production, this would fetch from database/Redis for real-time data
    const now = Date.now();
    
    // Mock current usage data (in reality, these would be actual counts)
    const usageData: RateLimitUsage = {
      requestsThisHour: Math.floor(Math.random() * 1000),
      requestsPerHourLimit: 1000,
      requestsToday: Math.floor(Math.random() * 50000) + 10000,
      requestsPerDayLimit: 100000,
      lastReset: new Date(now - 2 * 60 * 60 * 1000), // Reset 2 hours ago
      nextReset: new Date(now + 4 * 60 * 60 * 1000), // Reset in 4 hours
    };

    const endpointUsageData: EndpointUsage[] = [
      {
        endpoint: '/api/v1/feedback',
        method: 'POST',
        used: Math.floor(Math.random() * 500) + 200,
        limit: 1000,
        resetAt: new Date(now + 4 * 60 * 60 * 1000),
      },
      {
        endpoint: '/api/v1/users',
        method: 'GET',
        used: Math.floor(Math.random() * 300) + 100,
        limit: 1000,
        resetAt: new Date(now + 4 * 60 * 60 * 1000),
      },
      {
        endpoint: '/api/v1/projects',
        method: 'POST',
        used: Math.floor(Math.random() * 200) + 50,
        limit: 1000,
        resetAt: new Date(now + 4 * 60 * 60 * 1000),
      },
    ];

    console.log('[RATE LIMITS] Retrieved rate limit usage data');

    return NextResponse.json({ 
      usage: usageData,
      endpoints: endpointUsageData,
      planType: 'free', // Would be actual user's plan in production
      timestamp: new Date().toISOString()
    } as ApiResponse);
    
  } catch (error) {
    console.error('[RATE LIMITS] Error fetching rate limit data:', error);
    return NextResponse.json({ 
      error: 'Failed to fetch rate limit information' 
    }, { status: 500 });
  }
}
