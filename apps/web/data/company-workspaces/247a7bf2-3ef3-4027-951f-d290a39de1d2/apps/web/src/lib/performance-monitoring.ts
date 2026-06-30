/**
 * Performance Monitoring & SLO Tracking (TOUR-154)
 * 
 * Tracks application performance against SLO targets:
 * - 99.9% uptime
 * - <2s page load (Time to Interactive)
 * - <500ms API response time (p95)
 * 
 * Metrics are stored in-memory and can be exported to Datadog/Grafana via their APIs.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// ============================================================================
// SLO TARGETS
// ============================================================================

const SLO_TARGETS = {
  uptime: 99.9, // percentage
  pageLoadTime: 2000, // ms (Time to Interactive)
  apiResponseP95: 500, // ms
  errorRate: 1.0, // percentage of requests that fail
} as const;

// ============================================================================
// PERFORMANCE METRICS STORAGE
// In production, replace with Redis/database for persistence
// ============================================================================

interface PerformanceMetric {
  timestamp: string;
  metricName: string;
  value: number;
  labels?: Record<string, string>;
}

const performanceMetrics: PerformanceMetric[] = [];

function recordMetric(
  metricName: string, 
  value: number, 
  labels: Record<string, string> = {}
): void {
  performanceMetrics.push({
    timestamp: new Date().toISOString(),
    metricName,
    value,
    labels,
  });
  
  // Keep only last 1000 metrics in memory
  if (performanceMetrics.length > 1000) {
    performanceMetrics.shift();
  }
}

// ============================================================================
// REQUEST PERFORMANCE TRACKING (Middleware-style via API wrapper)
// ============================================================================

/**
 * Track a request's latency and record it as a metric.
 */
export async function trackRequest(
  method: string,
  path: string,
  responseTimeMs: number,
  statusCode: number
): Promise<void> {
  const isApi = path.startsWith('/api/');
  
  // Track API latency (SLO: <500ms p95)
  if (isApi) {
    recordMetric('api_response_time_ms', responseTimeMs, { method, path, status_code: String(statusCode) });
    
    // Count errors for error rate SLO (<1%)
    if (statusCode >= 400 && statusCode < 500) {
      recordMetric('client_errors_total', 1, { method, path });
    } else if (statusCode >= 500) {
      recordMetric('server_errors_total', 1, { method, path });
    }
  }
  
  // Track all requests for uptime calculation
  recordMetric('requests_total', 1, { method, path });
}

// ============================================================================
// UPTIME MONITORING
// ============================================================================

interface UptimeCheck {
  timestamp: string;
  status: 'up' | 'down';
  responseTimeMs?: number;
  error?: string;
}

const uptimeChecks: UptimeCheck[] = [];

/**
 * Record an uptime check result.
 */
export function recordUptimeCheck(status: 'up' | 'down', responseTimeMs?: number, error?: string): void {
  uptimeChecks.push({ timestamp: new Date().toISOString(), status, responseTimeMs, error });
  
  // Keep last 100 checks in memory
  if (uptimeChecks.length > 100) {
    uptimeChecks.shift();
  }
}

/**
 * Calculate current uptime percentage over the last N hours.
 */
export function calculateUptime(hours: number = 24): number {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const recentChecks = uptimeChecks.filter(c => c.timestamp >= cutoff);
  
  if (recentChecks.length === 0) return 100; // Assume up if no data
  
  const successfulChecks = recentChecks.filter(c => c.status === 'up').length;
  return Math.round((successfulChecks / recentChecks.length) * 10000) / 100;
}

/**
 * Calculate error rate over the last N hours.
 */
export function calculateErrorRate(hours: number = 24): number {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const recentMetrics = performanceMetrics.filter(m => 
    m.timestamp >= cutoff && (m.metricName === 'client_errors_total' || m.metricName === 'server_errors_total')
  );
  
  if (recentMetrics.length === 0) return 0;
  
  // This is a simplified calculation — in production, track total requests separately
  const errors = recentMetrics.reduce((sum, m) => sum + m.value, 0);
  const totalRequests = performanceMetrics.filter(m => 
    m.timestamp >= cutoff && m.metricName === 'requests_total'
  ).reduce((sum, m) => sum + m.value, 0);
  
  if (totalRequests === 0) return 0;
  return Math.round((errors / totalRequests) * 10000) / 100;
}

/**
 * Calculate p95 API response time over the last N hours.
 */
export function calculateP95ResponseTime(hours: number = 24): number {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const apiTimes = performanceMetrics
    .filter(m => m.timestamp >= cutoff && m.metricName === 'api_response_time_ms')
    .map(m => m.value)
    .sort((a, b) => a - b);
  
  if (apiTimes.length === 0) return 0;
  
  const p95Index = Math.floor(apiTimes.length * 0.95);
  return apiTimes[p95Index] || 0;
}

/**
 * Calculate average page load time (simulated — in production, use real browser metrics).
 */
export function calculateAvgPageLoadTime(hours: number = 24): number {
  // In production, this would come from the Web Vitals / LCP tracking via GA4 or RUM
  // For now, we track API times as a proxy and return simulated values
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const apiTimes = performanceMetrics
    .filter(m => m.timestamp >= cutoff && m.metricName === 'api_response_time_ms')
    .map(m => m.value);
  
  if (apiTimes.length === 0) return 350; // Default estimate
  
  const avgApiTime = apiTimes.reduce((a, b) => a + b, 0) / apiTimes.length;
  // Page load ≈ API time * 2 (for server rendering overhead) + network latency
  return Math.round(avgApiTime * 2.5);
}

// ============================================================================
// ALERTING ENGINE
// ============================================================================

interface Alert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  metric: string;
  threshold: number;
  currentValue: number;
  message: string;
  triggeredAt: string;
  acknowledged?: boolean;
}

const alerts: Alert[] = [];

/**
 * Check SLO targets and generate alerts if breached.
 */
export function checkSLOs(): Alert[] {
  const newAlerts: Alert[] = [];
  
  // Check uptime (target: 99.9%)
  const currentUptime = calculateUptime(24);
  if (currentUptime < SLO_TARGETS.uptime) {
    newAlerts.push({
      id: crypto.randomUUID(),
      severity: 'critical',
      metric: 'uptime_24h',
      threshold: SLO_TARGETS.uptime,
      currentValue: currentUptime,
      message: `Uptime dropped below ${SLO_TARGETS.uptime}% target: now at ${currentUptime}%`,
      triggeredAt: new Date().toISOString(),
    });
  }
  
  // Check error rate (target: <1%)
  const currentErrorRate = calculateErrorRate(24);
  if (currentErrorRate > SLO_TARGETS.errorRate) {
    newAlerts.push({
      id: crypto.randomUUID(),
      severity: 'warning',
      metric: 'error_rate_24h',
      threshold: SLO_TARGETS.errorRate,
      currentValue: currentErrorRate,
      message: `Error rate exceeded ${SLO_TARGETS.errorRate}% target: now at ${currentErrorRate}%`,
      triggeredAt: new Date().toISOString(),
    });
  }
  
  // Check p95 API response time (target: <500ms)
  const currentP95 = calculateP95ResponseTime(24);
  if (currentP95 > SLO_TARGETS.apiResponseP95) {
    newAlerts.push({
      id: crypto.randomUUID(),
      severity: 'warning',
      metric: 'api_p95_response_time_ms',
      threshold: SLO_TARGETS.apiResponseP95,
      currentValue: currentP95,
      message: `API p95 response time exceeded ${SLO_TARGETS.apiResponseP95}ms target: now at ${currentP95}ms`,
      triggeredAt: new Date().toISOString(),
    });
  }
  
  // Check page load (target: <2000ms)
  const currentPageLoad = calculateAvgPageLoadTime(24);
  if (currentPageLoad > SLO_TARGETS.pageLoadTime) {
    newAlerts.push({
      id: crypto.randomUUID(),
      severity: 'info',
      metric: 'avg_page_load_time_ms',
      threshold: SLO_TARGETS.pageLoadTime,
      currentValue: currentPageLoad,
      message: `Average page load time exceeded ${SLO_TARGETS.pageLoadTime}ms target: now at ${currentPageLoad}ms`,
      triggeredAt: new Date().toISOString(),
    });
  }
  
  // Add any breaches to the alerts log
  if (newAlerts.length > 0) {
    console.warn('[Performance] SLO Breaches Detected:', JSON.stringify(newAlerts, null, 2));
    alerts.push(...newAlerts);
    
    // In production: send to PagerDuty, Slack webhook, Datadog alerting endpoint
    notifySlack(webhookUrl, newAlerts);
  }
  
  return newAlerts;
}

// ============================================================================
// DATADOG / GRAFANA INTEGRATION HELPERS
// ============================================================================

/**
 * Send metrics to Datadog via their API.
 */
export async function sendToDatadog(metricName: string, value: number, tags?: Record<string, string>): Promise<boolean> {
  const apiKey = process.env.DATADOG_API_KEY;
  
  if (!apiKey) {
    console.warn('[Performance] DATADOG_API_KEY not set — metrics not forwarded');
    return false;
  }
  
  try {
    await fetch('https://api.datadoghq.com/api/v1/series', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': apiKey,
      },
      body: JSON.stringify({
        series: [{
          metric: `tourbillon.${metricName}`,
          points: [[Date.now() / 1000, value]],
          tags: Object.entries(tags || {}).map(([k, v]) => `${k}:${v}`),
        }],
      }),
    });
    
    return true;
  } catch (error) {
    console.error('[Performance] Failed to send metric to Datadog:', error);
    return false;
  }
}

/**
 * Send metrics to Grafana Cloud via its API.
 */
export async function sendToGrafana(metricName: string, value: number): Promise<boolean> {
  const instanceId = process.env.GRAFANA_INSTANCE_ID;
  const apiKey = process.env.GRAFANA_API_KEY;
  
  if (!instanceId || !apiKey) return false;
  
  try {
    await fetch(`https://${instanceId}.grafana.net/api/v1/prometheus/tourbillon/metrics`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metrics: [{
          metric: `tourbillon_${metricName}`,
          value,
          timestamp: Date.now(),
        }],
      }),
    });
    
    return true;
  } catch (error) {
    console.error('[Performance] Failed to send metric to Grafana:', error);
    return false;
  }
}

// ============================================================================
// SLACK NOTIFICATION FOR ALERTS
// ============================================================================

function webhookUrl(): string | undefined {
  return process.env.SLACK_WEBHOOK_URL_ALERTING;
}

async function notifySlack(webhook: string | undefined, alertList: Alert[]): Promise<void> {
  if (!webhook) {
    console.warn('[Performance] SLACK_WEBHOOK_URL_ALERTING not set — alerts not sent to Slack');
    return;
  }
  
  for (const alert of alertList) {
    const color = alert.severity === 'critical' ? '#ff0000' : 
                  alert.severity === 'warning' ? '#ffa500' : '#00ff00';
    
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*${alert.severity.toUpperCase()} — Tourbillon Performance Alert*\n${alert.message}\n_SLO Target_: ${alert.threshold}${alert.metric.includes('ms') ? 'ms' : '%'}\n_Current Value_: ${alert.currentValue}${alert.metric.includes('ms') ? 'ms' : '%'}`,
              },
            },
          ],
        }),
      });
    } catch (error) {
      console.error('[Performance] Failed to send Slack notification:', error);
    }
  }
}

// ============================================================================
// EXPORT FOR TESTING & DEBUGGING
// ============================================================================

export { performanceMetrics, uptimeChecks, alerts };
