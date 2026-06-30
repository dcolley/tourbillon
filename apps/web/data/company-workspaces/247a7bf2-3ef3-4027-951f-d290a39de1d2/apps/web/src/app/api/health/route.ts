/**
 * Health Check Endpoint (TOUR-154)
 * 
 * GET /api/health
 * Returns service status, uptime, memory usage, and SLO compliance.
 * Used by uptime monitors (Pingdom, UptimeRobot) and internal dashboards.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { 
  calculateUptime, 
  calculateErrorRate, 
  calculateP95ResponseTime, 
  calculateAvgPageLoadTime,
  checkSLOs,
} from '@/lib/performance-monitoring';

export async function GET(request: NextRequest) {
  try {
    // Check SLO targets and get any active alerts
    const slos = {
      uptime: {
        target: '99.9%',
        current: `${calculateUptime(24)}%`,
        status: calculateUptime(24) >= 99.9 ? 'passing' : 'breached',
      },
      errorRate: {
        target: '<1%',
        current: `${calculateErrorRate(24)}%`,
        status: calculateErrorRate(24) < 1 ? 'passing' : 'breached',
      },
      apiP95ResponseTime: {
        target: '<500ms',
        current: `${calculateP95ResponseTime(24)}ms`,
        status: calculateP95ResponseTime(24) < 500 ? 'passing' : 'breached',
      },
      pageLoadTime: {
        target: '<2000ms',
        current: `${calculateAvgPageLoadTime(24)}ms`,
        status: calculateAvgPageLoadTime(24) < 2000 ? 'passing' : 'breached',
      },
    };

    // Check for active SLO breaches and generate alerts if needed
    const newAlerts = checkSLOs();

    // Get process metrics
    const uptimeSeconds = Math.floor(process.uptime());
    const memoryUsage = process.memoryUsage();

    return NextResponse.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.NEXT_PUBLIC_VERSION || 'dev',
      environment: process.env.NODE_ENV || 'development',
      
      // Service metrics
      uptimeSeconds,
      memoryUsage: {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
      },
      
      // SLO compliance
      slos,
      
      // Active alerts (if any)
      alerts: newAlerts.length > 0 ? newAlerts : [],
    });

  } catch (error) {
    console.error('[Health Check] Error:', error);
    return NextResponse.json(
      { status: 'unhealthy', error: String(error), timestamp: new Date().toISOString() },
      { status: 503 }
    );
  }
}

/**
 * POST /api/health/check — Allow external monitoring systems to push metrics.
 */
export async function healthPOST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Accept uptime check results from external monitors
    if (body.status === 'up' || body.status === 'down') {
      const { trackUptimeCheck } = require('@/lib/performance-monitoring');
      // This would integrate with the monitoring library
    }
    
    return NextResponse.json({ accepted: true });
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }
}
