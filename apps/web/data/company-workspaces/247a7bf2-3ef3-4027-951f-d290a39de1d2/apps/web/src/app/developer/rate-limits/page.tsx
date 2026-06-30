'use client';

import { useState } from 'react';
import Link from 'next/link';

interface RateLimitTier {
  name: string;
  requestsPerHour: number;
  requestsPerDay: number;
  concurrentConnections: number;
  features: string[];
}

interface EndpointUsage {
  endpoint: string;
  method: string;
  used: number;
  limit: number;
  resetAt: Date;
}

export default function RateLimitsPage() {
  const [selectedTier, setSelectedTier] = useState<'free' | 'pro'>('free');

  // Current usage data (mock for now)
  const currentUsage = {
    requestsThisHour: 2847,
    requestsPerHourLimit: 1000,
    requestsToday: 32056,
    requestsPerDayLimit: 100000,
    lastReset: new Date(Date.now() - 2 * 60 * 60 * 1000), // Reset 2 hours ago
    nextReset: new Date(Date.now() + 4 * 60 * 60 * 1000), // Reset in 4 hours
  };

  const tierData: Record<string, RateLimitTier> = {
    free: {
      name: 'Free Tier',
      requestsPerHour: 1000,
      requestsPerDay: 100000,
      concurrentConnections: 5,
      features: ['Basic API access', 'Community support'],
    },
    pro: {
      name: 'Pro Plan',
      requestsPerHour: 10000,
      requestsPerDay: 1000000,
      concurrentConnections: 50,
      features: ['Higher rate limits', 'Priority support', 'Advanced analytics'],
    },
  };

  const endpointUsage: EndpointUsage[] = [
    {
      endpoint: '/api/v1/feedback',
      method: 'POST',
      used: 847,
      limit: 1000,
      resetAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
    },
    {
      endpoint: '/api/v1/users',
      method: 'GET',
      used: 523,
      limit: 1000,
      resetAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
    },
    {
      endpoint: '/api/v1/projects',
      method: 'POST',
      used: 234,
      limit: 1000,
      resetAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
    },
  ];

  const getProgressWidth = (used: number, limit: number): string => {
    const percentage = Math.min((used / limit) * 100, 100);
    
    if (percentage >= 90) return 'bg-red-500';
    if (percentage >= 75) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  const getUsageStatus = (used: number, limit: number): { text: string; color: string } => {
    const percentage = (used / limit) * 100;
    
    if (percentage >= 90) return { text: 'Critical', color: 'text-red-600 bg-red-100' };
    if (percentage >= 75) return { text: 'Warning', color: 'text-yellow-600 bg-yellow-100' };
    return { text: 'Normal', color: 'text-green-600 bg-green-100' };
  };

  const formatTime = (date: Date): string => {
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    
    if (diffHours < 1) {
      const minutes = Math.floor(diffMs / (1000 * 60));
      return `${minutes}m`;
    }
    return `${diffHours}h`;
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
              <span className="text-gray-900 font-medium">Rate Limits</span>
            </nav>
            <h1 className="text-2xl font-bold text-gray-900">API Rate Limits</h1>
            <p className="text-sm text-gray-600 mt-1">Monitor your API usage against quota limits and understand rate limiting policies</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Current Tier & Usage Overview */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
          {/* Current Usage Card */}
          <div className="bg-white border rounded-xl p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Current Usage</h3>
            
            <div className="space-y-6">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-700">Requests This Hour</span>
                  <span className="text-sm font-bold text-gray-900">{currentUsage.requestsThisHour.toLocaleString()} / {currentUsage.requestsPerHourLimit.toLocaleString()}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                  <div className={`h-3 transition-all duration-500 ${getProgressWidth(currentUsage.requestsThisHour, currentUsage.requestsPerHourLimit)}`}></div>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-700">Requests Today</span>
                  <span className="text-sm font-bold text-gray-900">{currentUsage.requestsToday.toLocaleString()} / {currentUsage.requestsPerDayLimit.toLocaleString()}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                  <div className={`h-3 transition-all duration-500 ${getProgressWidth(currentUsage.requestsToday, currentUsage.requestsPerDayLimit)}`}></div>
                </div>
              </div>

              <p className="text-sm text-gray-600">
                Rate limits reset in {formatTime(currentUsage.nextReset)}.
              </p>
            </div>
          </div>

          {/* Endpoint Breakdown Card */}
          <div className="bg-white border rounded-xl p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Endpoint Usage</h3>
            
            <div className="space-y-4">
              {endpointUsage.map((usage, index) => {
                const status = getUsageStatus(usage.used, usage.limit);
                
                return (
                  <div key={index} className="p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center justify-between mb-1">
                      <div>
                        <span className={`font-mono text-sm ${status.color.split(' ')[0]}`}>
                          {usage.method} {usage.endpoint}
                        </span>
                      </div>
                      <span className={`text-xs font-medium px-2 py-1 rounded-full ${status.color}`}>
                        {status.text}
                      </span>
                    </div>
                    
                    <div className="w-full bg-gray-300 rounded-full h-2 overflow-hidden">
                      <div 
                        className={`h-2 transition-all duration-500 ${getProgressWidth(usage.used, usage.limit)}`}
                        style={{ width: `${Math.min((usage.used / usage.limit) * 100, 100)}%` }}
                      ></div>
                    </div>
                    
                    <p className="text-xs text-gray-500 mt-1">
                      {usage.used.toLocaleString()} / {usage.limit.toLocaleString()} • Reset in {formatTime(usage.resetAt)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Tier Comparison */}
        <div className="bg-white border rounded-xl p-6 mb-8">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Plan Comparison</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {Object.values(tierData).map((tier, index) => (
              <button
                key={index}
                onClick={() => setSelectedTier(index === 0 ? 'free' : 'pro')}
                className={`p-4 rounded-xl border-2 transition-all ${
                  selectedTier === (index === 0 ? 'free' : 'pro')
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <h4 className="text-lg font-semibold text-gray-900 mb-2">{tier.name}</h4>
                
                <div className="space-y-2">
                  <p className="text-sm text-gray-600">
                    {tier.requestsPerHour.toLocaleString()} requests / hour
                  </p>
                  <p className="text-sm text-gray-600">
                    {tier.requestsPerDay.toLocaleString()} requests / day
                  </p>
                  <p className="text-sm text-gray-600">
                    {tier.concurrentConnections} concurrent connections
                  </p>
                </div>

                <ul className="mt-4 space-y-1">
                  {tier.features.map((feature, i) => (
                    <li key={i} className="text-sm text-gray-600 flex items-center space-x-2">
                      <span className="text-green-500">✓</span>
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                {index === 1 && (
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      alert('Upgrade to Pro Plan - In production, this would redirect to payment checkout.');
                    }}
                    className="w-full mt-4 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg font-medium transition-colors"
                  >
                    Upgrade to Pro
                  </button>
                )}

                {index === 0 && (
                  <p className="text-sm text-gray-500 mt-4">
                    Current plan
                  </p>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Info Section */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-3">ℹ️ About Rate Limits</h3>
          <p className="text-blue-800 mb-4">
            API rate limits protect the platform from excessive usage and ensure fair access for all users. 
            When you exceed your limit, you'll receive a 429 Too Many Requests response with guidance on when to retry.
          </p>
          
          <div className="grid md:grid-cols-3 gap-6 mt-4">
            <div>
              <h4 className="font-semibold text-blue-900 mb-2">Rate Limit Headers</h4>
              <p className="text-sm text-blue-800">
                Every API response includes rate limit headers:
                <code className="block bg-white px-2 py-1 rounded border mt-1 font-mono text-xs">
                  X-RateLimit-Limit<br/>
                  X-RateLimit-Remaining<br/>
                  X-RateLimit-Reset
                </code>
              </p>
            </div>

            <div>
              <h4 className="font-semibold text-blue-900 mb-2">Best Practices</h4>
              <ul className="space-y-1 text-sm text-blue-800">
                <li>• Use caching to reduce repeated requests</li>
                <li>• Implement exponential backoff on 429 responses</li>
                <li>• Batch operations when possible</li>
              </ul>
            </div>

            <div>
              <h4 className="font-semibold text-blue-900 mb-2">Need Higher Limits?</h4>
              <p className="text-sm text-blue-800">
                Enterprise plans offer custom rate limits and dedicated support. 
                Contact us for a tailored solution.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
