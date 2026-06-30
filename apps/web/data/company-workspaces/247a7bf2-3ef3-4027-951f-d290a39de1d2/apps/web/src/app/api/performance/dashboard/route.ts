/**
 * Performance Dashboard API (TOUR-154)
 * 
 * GET /api/performance/dashboard
 * Returns comprehensive performance metrics for internal dashboards.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { 
  calculateUptime, 
  calculateErrorRate, 
  calculateP95ResponseTime, 
  calculateAvgPageLoadTime,
  performanceMetrics,
  uptimeChecks,
} from '@/lib/performance-monitoring';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const windowHours = parseInt(url.searchParams.get('window') || '24', 10);
    
    // Calculate all metrics for the specified time window
    const metrics = {
      uptime: `${calculateUptime(windowHours)}%`,
      errorRate: `${calculateErrorRate(windowHours)}%`,
      p95ResponseTime: `${calculateP95ResponseTime(windowHours)}ms`,
      pageLoadTime: `${calculateAvgPageLoadTime(windowHours)}ms`,
    };

    // Get recent performance data for charts
    const apiLatencies = performanceMetrics
      .filter(m => m.metricName === 'api_response_time_ms')
      .slice(-100) // Last 100 requests
      .map(m => ({ time: new Date(m.timestamp).toISOString(), value: m.value }));

    const errorCounts = {
      clientErrors: performanceMetrics.filter(
        m => m.metricName === 'client_errors_total' && 
             new Date(m.timestamp).getTime() >= Date.now() - windowHours * 3600 * 1000
      ).reduce((sum, m) => sum + m.value, 0),
      
      serverErrors: performanceMetrics.filter(
        m => m.metricName === 'server_errors_total' && 
             new Date(m.timestamp).getTime() >= Date.now() - windowHours * 3600 * 1000
      ).reduce((sum, m) => sum + m.value, 0),
    };

    const totalRequests = performanceMetrics.filter(
      m => m.metricName === 'requests_total' && 
           new Date(m.timestamp).getTime() >= Date.now() - windowHours * 3600 * 1000
    ).reduce((sum, m) => sum + m.value, 0);

    return NextResponse.json({
      metrics,
      uptimeChecks: {
        total: uptimeChecks.length,
        recentStatuses: uptimeChecks.slice(-24).map(c => ({ time: c.timestamp, status: c.status })),
      },
      errorCounts,
      totalRequests,
      apiLatencies,
    });

  } catch (error) {
    console.error('[Performance Dashboard] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
