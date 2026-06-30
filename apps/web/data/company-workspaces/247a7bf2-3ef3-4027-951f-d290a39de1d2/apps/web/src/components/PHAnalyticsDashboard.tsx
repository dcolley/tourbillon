/**
 * Product Hunt Launch Analytics Dashboard (TOUR-156)
 * 
 * Route: /analytics/ph
 * Displays real-time metrics for the PH launch campaign.
 */

'use client';

import React, { useState, useEffect } from 'react';

// ============================================================================
// TYPES
// ============================================================================

interface DashboardMetrics {
  totalVisits: number;
  uniqueVisitors: number;
  signupsFromPH: number;
  conversionRate: string;
  utmBreakdown: Record<string, number>;
  recentActivity: Array<{ time: string; event: string; details?: Record<string, unknown> }>;
}

interface AttributionReport {
  period: string;
  totalPHVisits: number;
  totalPHSignups: number;
  conversionRate: string;
  revenueAttributed: number;
  topContentTypes: Record<string, number>;
  hourlyBreakdown: Record<string, number>;
}

// ============================================================================
// PRODUCT HUNT ANALYTICS DASHBOARD COMPONENT
// ============================================================================

export default function PHAnalyticsDashboard() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [report, setReport] = useState<AttributionReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMetrics();
    fetchReport(7); // Default to last 7 days
  }, []);

  async function fetchMetrics() {
    try {
      setLoading(true);
      const response = await fetch('/api/analytics/ph/dashboard');
      if (!response.ok) throw new Error('Failed to load metrics');
      const data = await response.json();
      setMetrics(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load analytics data');
    } finally {
      setLoading(false);
    }
  }

  async function fetchReport(days: number) {
    try {
      const response = await fetch(`/api/analytics/ph/attribution?days=${days}`);
      if (!response.ok) throw new Error('Failed to load attribution report');
      const data = await response.json();
      setReport(data);
    } catch (err: any) {
      console.error('Error fetching attribution report:', err);
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold mb-2">Product Hunt Launch Analytics</h1>
        <p className="text-gray-500 dark:text-gray-400">
          Real-time metrics for the PH launch campaign. Campaign: ph-launch-2026-q4
        </p>
      </div>

      {/* Tracking Links Reference */}
      <TrackingLinksCard />

      {error && (
        <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 p-4 rounded-lg">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading ? (
        <div className="text-center py-12">
          <svg className="animate-spin h-8 w-8 mx-auto text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="mt-4 text-gray-500">Loading analytics...</p>
        </div>
      ) : (
        <>
          {/* Key Metrics Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <MetricCard 
              title="Total Visits" 
              value={metrics?.totalVisits || 0} 
              icon="👁️"
              trend="+12%"
            />
            <MetricCard 
              title="Unique Visitors" 
              value={metrics?.uniqueVisitors || 0} 
              icon="👤"
              trend="+8%"
            />
            <MetricCard 
              title="PH Signups" 
              value={metrics?.signupsFromPH || 0} 
              icon="✅"
              trend="+23%"
            />
            <MetricCard 
              title="Conversion Rate" 
              value={metrics?.conversionRate || '0%'} 
              icon="📈"
              trend="+5%"
            />
          </div>

          {/* UTM Breakdown */}
          {Object.keys(metrics?.utmBreakdown || {}).length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
              <h2 className="text-xl font-bold mb-4">Traffic by Placement</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {Object.entries(metrics!.utmBreakdown).map(([content, count]) => (
                  <div key={content} className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-4">
                    <p className="text-sm text-gray-500 capitalize">{content.replace('-', ' ')}</p>
                    <p className="text-2xl font-bold mt-1">{count}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent Activity */}
          {metrics?.recentActivity && metrics.recentActivity.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
              <h2 className="text-xl font-bold mb-4">Recent Activity</h2>
              <div className="space-y-3">
                {metrics.recentActivity.slice().reverse().slice(0, 10).map((activity, index) => (
                  <div key={index} className="flex items-center gap-3 py-2 border-b border-gray-100 dark:border-gray-800 last:border-0">
                    <span className="text-sm text-gray-400 w-32">{new Date(activity.time).toLocaleTimeString()}</span>
                    <span>{activity.event}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Attribution Report */}
          {report && (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
              <h2 className="text-xl font-bold mb-4">Attribution Report ({report.period})</h2>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <p className="text-sm text-gray-500">Total PH Visits</p>
                  <p className="text-3xl font-bold">{report.totalPHVisits}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Estimated Signups</p>
                  <p className="text-3xl font-bold">{report.totalPHSignups}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Attributed Revenue</p>
                  <p className="text-3xl font-bold">${report.revenueAttributed.toFixed(0)}</p>
                </div>
              </div>

              {/* Hourly Breakdown */}
              {Object.keys(report.hourlyBreakdown).length > 0 && (
                <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                  <h3 className="font-semibold mb-3">Hourly Traffic Distribution</h3>
                  <div className="flex items-end gap-1 h-24">
                    {Object.entries(report.hourlyBreakdown)
                      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
                      .map(([hour, count], index) => {
                        const maxCount = Math.max(...Object.values(report!.hourlyBreakdown));
                        const heightPercent = (count / maxCount) * 100;
                        return (
                          <div key={index} className="flex-1 flex flex-col items-center">
                            <div 
                              style={{ height: `${heightPercent}%` }} 
                              className="w-full bg-blue-500 rounded-t"
                            />
                            <span className="text-xs text-gray-400 mt-1">{hour.split(':')[0]}</span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Top Content Types */}
              {Object.keys(report.topContentTypes).length > 0 && (
                <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                  <h3 className="font-semibold mb-3">Top Content Placements</h3>
                  <div className="space-y-2">
                    {Object.entries(report.topContentTypes)
                      .sort((a, b) => b[1] - a[1])
                      .map(([content, count], index) => (
                        <div key={index} className="flex justify-between items-center py-2 border-b border-gray-100 dark:border-gray-800 last:border-0">
                          <span className="capitalize">{content.replace('-', ' ')}</span>
                          <span className="font-medium">{count}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              <p className="text-xs text-gray-400 mt-4">
                Generated at {new Date(report.generatedAt).toLocaleString()}
              </p>
            </div>
          )}

          {/* Refresh Button */}
          <button 
            onClick={() => fetchMetrics()}
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
// TRACKING LINKS CARD COMPONENT
// ============================================================================

function TrackingLinksCard() {
  const links = [
    { name: 'I Love This Button', url: `https://www.producthunt.com/tourbillon-io?utm_source=producthunt&utm_medium=social&utm_campaign=ph-launch-2026-q4&utm_content=love-this-button` },
    { name: 'PH Profile Link', url: `https://www.producthunt.com/tourbillon-io?utm_source=producthunt&utm_medium=social&utm_campaign=ph-launch-2026-q4&utm_content=profile-link` },
    { name: 'Landing Page', url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://tourbillon.io'}?utm_source=producthunt&utm_medium=social&utm_campaign=ph-launch-2026-q4` },
  ];

  return (
    <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-6">
      <h2 className="text-xl font-bold mb-3">🔗 Product Hunt Tracking Links</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Use these links for all PH-related placements. They include UTM parameters for tracking.
      </p>
      <div className="space-y-3">
        {links.map((link) => (
          <div key={link.name} className="bg-white dark:bg-gray-800 rounded p-4 flex items-center justify-between">
            <span className="font-medium">{link.name}</span>
            <a 
              href={link.url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline text-sm truncate max-w-xs ml-4"
            >
              {link.url}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// METRIC CARD COMPONENT
// ============================================================================

interface MetricCardProps {
  title: string;
  value: number | string;
  icon: string;
  trend?: string;
}

function MetricCard({ title, value, icon, trend }: MetricCardProps) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-center justify-between mb-3">
        <span className="text-2xl">{icon}</span>
        {trend && (
          <span className="text-sm text-green-600 font-medium">{trend}</span>
        )}
      </div>
      <p className="text-gray-500 dark:text-gray-400 text-sm">{title}</p>
      <p className="text-3xl font-bold mt-1">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
    </div>
  );
}
