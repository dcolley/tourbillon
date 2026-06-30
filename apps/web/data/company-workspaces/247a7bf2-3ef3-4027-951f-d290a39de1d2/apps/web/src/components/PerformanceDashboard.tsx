/**
 * Performance Dashboard UI Component (TOUR-154)
 * 
 * Displays real-time SLO compliance, error rates, latency charts,
 * and active alerts for the engineering team.
 */

'use client';

import React, { useState, useEffect } from 'react';

// ============================================================================
// TYPES
// ============================================================================

interface PerformanceMetrics {
  uptime: string;
  errorRate: string;
  p95ResponseTime: string;
  pageLoadTime: string;
}

interface ErrorCounts {
  clientErrors: number;
  serverErrors: number;
}

interface ApiLatencyPoint {
  time: string;
  value: number;
}

interface DashboardData {
  metrics: PerformanceMetrics;
  uptimeChecks: { total: number; recentStatuses: Array<{ time: string; status: 'up' | 'down' }> };
  errorCounts: ErrorCounts;
  totalRequests: number;
  apiLatencies: ApiLatencyPoint[];
}

interface Alert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  metric: string;
  threshold: number;
  currentValue: number;
  message: string;
  triggeredAt: string;
}

// ============================================================================
// PERFORMANCE DASHBOARD COMPONENT
// ============================================================================

export default function PerformanceDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMetrics();
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchMetrics, 30000);
    return () => clearInterval(interval);
  }, []);

  async function fetchMetrics() {
    try {
      setLoading(true);
      const [metricsRes, healthRes] = await Promise.all([
        fetch('/api/performance/dashboard?window=24'),
        fetch('/api/health'),
      ]);

      if (!metricsRes.ok || !healthRes.ok) throw new Error('Failed to load metrics');

      const metricsData = await metricsRes.json();
      const healthData = await healthRes.json();

      setData(metricsData);
      setAlerts(healthData.alerts || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load performance data');
    } finally {
      setLoading(false);
    }
  }

  const getMetricStatus = (value: string, target: string): 'passing' | 'warning' | 'critical' => {
    // Simple status check based on SLO targets
    if (value.includes('%')) return 'passing'; // Default to passing for display
    return 'passing';
  };

  const getStatusColor = (status: 'passing' | 'warning' | 'critical'): string => {
    switch (status) {
      case 'critical': return 'text-red-600 dark:text-red-400';
      case 'warning': return 'text-yellow-600 dark:text-yellow-400';
      default: return 'text-green-600 dark:text-green-400';
    }
  };

  const getAlertColor = (severity: string): string => {
    switch (severity) {
      case 'critical': return 'bg-red-100 border-red-300 text-red-800 dark:bg-red-950/30 dark:border-red-700 dark:text-red-200';
      case 'warning': return 'bg-yellow-100 border-yellow-300 text-yellow-800 dark:bg-yellow-950/30 dark:border-yellow-700 dark:text-yellow-200';
      default: return 'bg-blue-100 border-blue-300 text-blue-800 dark:bg-blue-950/30 dark:border-blue-700 dark:text-blue-200';
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold mb-2">Performance Monitoring</h1>
        <p className="text-gray-500 dark:text-gray-400">
          Real-time SLO monitoring for Tourbillon platform stability.
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 p-4 rounded-lg">
          {error}
        </div>
      )}

      {/* Active Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-xl font-bold text-red-600 dark:text-red-400">⚠️ Active SLO Breaches</h2>
          {alerts.map((alert) => (
            <div key={alert.id} className={`border rounded-lg p-4 ${getAlertColor(alert.severity)}`}>
              <p className="font-semibold">{alert.message}</p>
              <p className="text-sm opacity-75 mt-1">Triggered at {new Date(alert.triggeredAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}

      {/* Loading State */}
      {loading && !data ? (
        <div className="text-center py-12">
          <svg className="animate-spin h-8 w-8 mx-auto text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="mt-4 text-gray-500">Loading performance metrics...</p>
        </div>
      ) : (
        <>
          {/* SLO Status Cards */}
          {data && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              {/* Uptime */}
              <MetricCard 
                title="Uptime (24h)"
                value={data.metrics.uptime}
                target="99.9%"
                icon="🟢"
                status={parseFloat(data.metrics.uptime) >= 99.9 ? 'passing' : 'critical'}
              />

              {/* Error Rate */}
              <MetricCard 
                title="Error Rate (24h)"
                value={data.metrics.errorRate}
                target="<1%"
                icon="📊"
                status={parseFloat(data.metrics.errorRate) < 1 ? 'passing' : 'warning'}
              />

              {/* API P95 */}
              <MetricCard 
                title="API p95 Latency"
                value={data.metrics.p95ResponseTime}
                target="<500ms"
                icon="⚡"
                status={parseInt(data.metrics.p95ResponseTime) < 500 ? 'passing' : 'warning'}
              />

              {/* Page Load */}
              <MetricCard 
                title="Avg Page Load"
                value={data.metrics.pageLoadTime}
                target="<2s"
                icon="🚀"
                status={parseInt(data.metrics.pageLoadTime) < 2000 ? 'passing' : 'warning'}
              />
            </div>
          )}

          {/* Error Counts & Request Stats */}
          {data && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <StatCard title="Client Errors" value={data.errorCounts.clientErrors} icon="⚠️" />
              <StatCard title="Server Errors" value={data.errorCounts.serverErrors} icon="🔴" />
              <StatCard title="Total Requests" value={data.totalRequests.toLocaleString()} icon="📈" />
            </div>
          )}

          {/* Uptime Status Grid */}
          {data && (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
              <h2 className="text-xl font-bold mb-4">Uptime Status (Last 24 Hours)</h2>
              <div className="flex flex-wrap gap-1">
                {data.uptimeChecks.recentStatuses.map((check, index) => (
                  <div 
                    key={index}
                    className={`w-3 h-8 rounded ${check.status === 'up' ? 'bg-green-500' : 'bg-red-500'}`}
                    title={`${new Date(check.time).toLocaleTimeString()}: ${check.status}`}
                  />
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">Each block = ~30 minutes of uptime check</p>
            </div>
          )}

          {/* SLO Summary Table */}
          {data && (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
              <h2 className="text-xl font-bold mb-4">SLO Compliance</h2>
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="pb-3 font-medium text-sm text-gray-500">SLO Target</th>
                    <th className="pb-3 font-medium text-sm text-gray-500">Current Value</th>
                    <th className="pb-3 font-medium text-sm text-gray-500">Status</th>
                  </tr>
                </thead>
                <tbody>
                  <SLORow metric="Uptime (24h)" current={data.metrics.uptime} target="99.9%" />
                  <SLORow metric="Error Rate" current={data.metrics.errorRate} target="<1%" />
                  <SLORow metric="API p95 Latency" current={data.metrics.p95ResponseTime} target="<500ms" />
                  <SLORow metric="Page Load Time" current={data.metrics.pageLoadTime} target="<2s" />
                </tbody>
              </table>
            </div>
          )}

          {/* Refresh Button */}
          <button 
            onClick={fetchMetrics}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium"
          >
            Refresh Metrics
          </button>
        </>
      )}
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

interface MetricCardProps {
  title: string;
  value: string;
  target: string;
  icon: string;
  status: 'passing' | 'warning' | 'critical';
}

function MetricCard({ title, value, target, icon, status }: MetricCardProps) {
  const color = status === 'critical' ? 'text-red-600 dark:text-red-400' 
              : status === 'warning' ? 'text-yellow-600 dark:text-yellow-400' 
              : 'text-green-600 dark:text-green-400';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
      <span className="text-2xl">{icon}</span>
      <p className="text-sm text-gray-500 mt-3">{title}</p>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-gray-400 mt-1">Target: {target}</p>
    </div>
  );
}

interface StatCardProps {
  title: string;
  value: number | string;
  icon: string;
}

function StatCard({ title, value, icon }: StatCardProps) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
      <span className="text-2xl">{icon}</span>
      <p className="text-sm text-gray-500 mt-3">{title}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
    </div>
  );
}

interface SLORowProps {
  metric: string;
  current: string;
  target: string;
}

function SLORow({ metric, current, target }: SLORowProps) {
  // Determine status based on simple comparison
  const isPercentage = current.includes('%');
  const value = parseFloat(current);
  
  let status: 'passing' | 'warning' | 'critical';
  
  if (metric === 'Uptime') status = value >= 99.9 ? 'passing' : 'critical';
  else if (metric === 'Error Rate') status = value < 1 ? 'passing' : 'warning';
  else if (metric === 'API p95 Latency') status = parseInt(current) < 500 ? 'passing' : 'warning';
  else if (metric === 'Page Load Time') status = parseInt(current) < 2000 ? 'passing' : 'warning';
  else status = 'passing';

  const color = status === 'critical' ? 'text-red-600 dark:text-red-400' 
              : status === 'warning' ? 'text-yellow-600 dark:text-yellow-400' 
              : 'text-green-600 dark:text-green-400';

  return (
    <tr className="border-b border-gray-100 dark:border-gray-800 last:border-0">
      <td className="py-3">{metric}</td>
      <td className={`py-3 font-medium ${color}`}>{current}</td>
      <td className="text-sm text-gray-500">Target: {target}</td>
    </tr>
  );
}
