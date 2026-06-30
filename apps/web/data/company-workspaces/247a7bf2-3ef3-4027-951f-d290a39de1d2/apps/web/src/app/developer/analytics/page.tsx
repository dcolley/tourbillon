'use client';

import { useState } from 'react';
import Link from 'next/link';

interface AnalyticsDataPoint {
  date: string;
  requests: number;
}

interface TimeRange {
  label: string;
  days: number;
}

export default function UsageAnalyticsPage() {
  const [selectedRange, setSelectedRange] = useState<TimeRange>({ label: 'Last 7 days', days: 7 });
  const [loading, setLoading] = useState(false);
  const [dataPoints, setDataPoints] = useState<AnalyticsDataPoint[]>([]);

  // Time range options
  const timeRanges: TimeRange[] = [
    { label: 'Last 7 days', days: 7 },
    { label: 'Last 14 days', days: 14 },
    { label: 'Last 30 days', days: 30 },
    { label: 'Last 90 days', days: 90 },
  ];

  // Fetch analytics data
  const fetchAnalytics = async (range: TimeRange) => {
    setLoading(true);
    
    try {
      // In production, this would call the API endpoint
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Generate mock data based on the selected range
      const now = new Date();
      const newData: AnalyticsDataPoint[] = [];
      
      for (let i = range.days - 1; i >= 0; i--) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        
        // Generate random but realistic request counts
        const requests = Math.floor(Math.random() * 200) + 50;
        
        newData.push({
          date: date.toISOString().split('T')[0],
          requests,
        });
      }
      
      setDataPoints(newData);
    } catch (error) {
      console.error('Failed to fetch analytics:', error);
    } finally {
      setLoading(false);
    }
  };

  // Export data as CSV
  const exportToCSV = () => {
    if (dataPoints.length === 0) return;
    
    const headers = ['Date', 'Requests'];
    const csvContent = [
      headers.join(','),
      ...dataPoints.map(point => `${point.date},${point.requests}`)
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `usage-analytics-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  // Calculate summary statistics
  const totalRequests = dataPoints.reduce((sum, point) => sum + point.requests, 0);
  const avgDaily = dataPoints.length > 0 ? Math.round(totalRequests / dataPoints.length) : 0;
  const maxDaily = dataPoints.length > 0 ? Math.max(...dataPoints.map(p => p.requests)) : 0;

  // Handle range change
  const handleRangeChange = (range: TimeRange) => {
    setSelectedRange(range);
    fetchAnalytics(range);
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <nav className="flex items-center space-x-2 text-sm text-gray-500 mb-1">
              <Link href="/developer" className="hover:text-blue-600 transition-colors">Developer Portal</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">Usage Analytics</span>
            </nav>
            <h1 className="text-2xl font-bold text-gray-900">Usage Analytics</h1>
            <p className="text-sm text-gray-600 mt-1">Monitor API endpoint usage with trend visualization and exportable data</p>
          </div>
          {dataPoints.length > 0 && (
            <button 
              onClick={exportToCSV}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors flex items-center space-x-2"
            >
              <span>📊 Export CSV</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Time Range Selector */}
        <div className="mb-8 flex items-center space-x-4">
          <span className="text-sm font-medium text-gray-700">Time Range:</span>
          <div className="flex space-x-2">
            {timeRanges.map((range) => (
              <button
                key={range.days}
                onClick={() => handleRangeChange(range)}
                disabled={loading}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  selectedRange.days === range.days
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white border rounded-xl p-6">
            <h3 className="text-sm font-medium text-gray-500 mb-2">Total Requests</h3>
            <p className="text-3xl font-bold text-gray-900">{totalRequests.toLocaleString()}</p>
          </div>
          
          <div className="bg-white border rounded-xl p-6">
            <h3 className="text-sm font-medium text-gray-500 mb-2">Daily Average</h3>
            <p className="text-3xl font-bold text-blue-600">{avgDaily.toLocaleString()}</p>
          </div>
          
          <div className="bg-white border rounded-xl p-6">
            <h3 className="text-sm font-medium text-gray-500 mb-2">Peak Day</h3>
            <p className="text-3xl font-bold text-green-600">{maxDaily.toLocaleString()}</p>
          </div>
        </div>

        {/* Chart Area */}
        <div className="bg-white border rounded-xl p-6 mb-8">
          {loading ? (
            <div className="flex items-center justify-center h-96">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            </div>
          ) : dataPoints.length === 0 ? (
            <div className="text-center py-16 bg-gray-50 border-2 border-dashed border-gray-300 rounded-lg">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">No analytics data available</h3>
              <p className="text-gray-600 mb-4 max-w-md mx-auto">
                Select a time range to view your API usage trends and request counts.
              </p>
            </div>
          ) : (
            <>
              {/* Simple Bar Chart */}
              <div className="h-96 mb-8 flex items-end justify-between space-x-1 px-4">
                {dataPoints.map((point, index) => {
                  const maxRequests = Math.max(...dataPoints.map(p => p.requests));
                  const heightPercentage = (point.requests / maxRequests) * 100;
                  
                  return (
                    <div key={index} className="flex-1 flex flex-col items-center justify-end group">
                      {/* Tooltip */}
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity mb-2 bg-gray-900 text-white text-xs px-2 py-1 rounded">
                        {point.date}: {point.requests.toLocaleString()} requests
                      </div>
                      
                      {/* Bar */}
                      <div 
                        className="w-full max-w-[40px] bg-blue-500 hover:bg-blue-600 transition-colors rounded-t"
                        style={{ height: `${heightPercentage}%` }}
                      ></div>
                      
                      {/* X-axis label (show every Nth point) */}
                      {index % Math.ceil(dataPoints.length / 7) === 0 && (
                        <span className="text-xs text-gray-500 mt-2 whitespace-nowrap">
                          {new Date(point.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Legend */}
              <div className="flex items-center justify-between text-sm text-gray-600">
                <span>📊 API Requests per Day</span>
                <span>Source: tourbillon.org analytics</span>
              </div>
            </>
          )}
        </div>

        {/* Data Table */}
        {dataPoints.length > 0 && (
          <div className="bg-white border rounded-xl p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Detailed Breakdown</h3>
            
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Requests</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {[...dataPoints].reverse().map((point, index) => (
                    <tr key={index} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {new Date(point.date).toLocaleDateString('en-US', { 
                          weekday: 'short',
                          year: 'numeric', 
                          month: 'short', 
                          day: 'numeric' 
                        })}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 text-right">
                        {point.requests.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Info Section */}
        <div className="mt-12 bg-blue-50 border border-blue-200 rounded-xl p-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-3">📈 Understanding Your Usage</h3>
          <p className="text-blue-800 mb-4">
            Track your API usage patterns to optimize performance and plan for scaling. 
            Monitor peak times, average request volumes, and identify trends over time.
          </p>
          
          <div className="grid md:grid-cols-2 gap-6 mt-4">
            <div>
              <h4 className="font-semibold text-blue-900 mb-2">Tips for Optimization</h4>
              <ul className="space-y-1 text-sm text-blue-800">
                <li>• Use caching to reduce repeated requests</li>
                <li>• Batch multiple operations when possible</li>
                <li>• Monitor peak hours and schedule batch jobs accordingly</li>
              </ul>
            </div>

            <div>
              <h4 className="font-semibold text-blue-900 mb-2">Rate Limits</h4>
              <p className="text-sm text-blue-800">
                Current rate limit: 1,000 requests per hour. 
                Upgrade to Enterprise for higher limits and dedicated support.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
