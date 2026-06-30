// ============================================================================
// TOUR-119: Usage Analytics — Data Endpoint
// 
// GET    /api/usage - Get usage analytics data (per-day API endpoint counts)
// ============================================================================

import { NextResponse } from 'next/server';

interface UsageDataPoint {
  date: string; // YYYY-MM-DD format
  requests: number;
}

interface ApiResponse {
  data?: UsageDataPoint[];
  totalRequests?: number;
  averageDaily?: number;
  peakDay?: number;
  error?: string;
}

/**
 * GET - Get usage analytics data for the specified time range
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const daysParam = url.searchParams.get('days') || '7';
    const days = parseInt(daysParam, 10);

    // Validate input
    if (isNaN(days) || days < 1 || days > 365) {
      return NextResponse.json({ 
        error: 'Invalid time range. Must be between 1 and 365 days.' 
      }, { status: 400 });
    }

    // Generate mock usage data (in production, fetch from database/analytics service)
    const now = new Date();
    const dataPoints: UsageDataPoint[] = [];
    
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      
      // Generate realistic request counts with some variance
      const baseRequests = 50 + Math.floor(Math.random() * 200);
      
      dataPoints.push({
        date: date.toISOString().split('T')[0],
        requests: baseRequests,
      });
    }

    // Calculate summary statistics
    const totalRequests = dataPoints.reduce((sum, point) => sum + point.requests, 0);
    const averageDaily = Math.round(totalRequests / days);
    const peakDay = Math.max(...dataPoints.map(p => p.requests));

    console.log(`[USAGE] Retrieved ${days}-day analytics data: ${totalRequests} total requests`);

    return NextResponse.json({ 
      data: dataPoints,
      totalRequests,
      averageDaily,
      peakDay,
      timestamp: new Date().toISOString()
    } as ApiResponse);
    
  } catch (error) {
    console.error('[USAGE] Error fetching analytics data:', error);
    return NextResponse.json({ 
      error: 'Failed to fetch usage analytics' 
    }, { status: 500 });
  }
}
