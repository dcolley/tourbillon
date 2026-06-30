'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface IntegrationStatus {
  id: string;
  type: 'slack' | 'github' | 'google';
  connected: boolean;
  name?: string;
  details?: Record<string, unknown>;
  status: 'active' | 'inactive' | 'disconnected';
}

interface IntegrationSummary {
  total: number;
  connected: number;
  disconnected: number;
}

interface IntegrationsResponse {
  integrations: IntegrationStatus[];
  summary: IntegrationSummary;
}

// Activity type for recent activity feed
interface ActivityItem {
  id: string;
  message: string;
  timestamp: Date;
  type: 'integration' | 'api_key' | 'webhook' | 'rate_limit';
}

export default function DeveloperDashboardPage() {
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [summary, setSummary] = useState<IntegrationSummary>({ total: 0, connected: 0, disconnected: 0 });
  const [loading, setLoading] = useState(true);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  useEffect(() => {
    fetchIntegrations();
  }, []);

  const fetchIntegrations = async () => {
    try {
      const res = await fetch('/api/integrations');
      const data: IntegrationsResponse = await res.json();
      setIntegrations(data.integrations || []);
      setSummary(data.summary || { total: 0, connected: 0, disconnected: 0 });
    } catch (error) {
      console.error('Failed to fetch integrations:', error);
    } finally {
      setLoading(false);
    }
  };

  const disconnectIntegration = async (id: string, type: string) => {
    if (!confirm(`Are you sure you want to disconnect ${type}? This action cannot be undone without re-authorizing.`)) return;
    
    setDisconnectingId(id);
    try {
      await fetch('/api/integrations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, type }),
      });
      
      // Refresh the integrations list
      fetchIntegrations();
    } catch (error) {
      console.error('Failed to disconnect integration:', error);
    } finally {
      setDisconnectingId(null);
    }
  };

  const connectIntegration = async (type: 'slack' | 'github' | 'google') => {
    try {
      // Route to the appropriate OAuth endpoint
      const routeMap = {
        slack: '/api/slack/connect',
        github: '/api/github/connect',
        google: '/api/google/connect',
      };

      window.location.href = routeMap[type];
    } catch (error) {
      console.error(`Failed to initiate ${type} connection:`, error);
    }
  };

  const formatDate = (date: Date): string => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffHours < 72) return `${Math.floor(diffHours / 24)}d ago`;
    return date.toLocaleDateString();
  };

  // Generate sample activity items for demo purposes
  const getActivityItems = (): ActivityItem[] => {
    const now = new Date();
    return [
      {
        id: '1',
        message: 'Slack connection established — Demo Team workspace',
        timestamp: new Date(now.getTime() - 5 * 60 * 1000), // 5 min ago
        type: 'integration',
      },
      {
        id: '2',
        message: 'API key sk_live_...xM7d created for production use',
        timestamp: new Date(now.getTime() - 2 * 60 * 60 * 1000), // 2h ago
        type: 'api_key',
      },
      {
        id: '3',
        message: 'Rate limit quota refreshed — 10K requests reset',
        timestamp: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), // 3d ago
        type: 'rate_limit',
      },
    ];
  };

  const activityItems = getActivityItems();

  // Helper to render integration card details based on type
  const renderIntegrationDetails = (integration: IntegrationStatus) => {
    if (!integration.connected || !integration.details) return null;

    switch (integration.type) {
      case 'slack': {
        const channels = integration.details.channels as string[] | undefined;
        return (
          <div className="mt-2">
            <p className="text-sm text-gray-600 mb-1">Channels:</p>
            <div className="flex flex-wrap gap-2">
              {channels?.map((channel, idx) => (
                <span key={idx} className="inline-flex items-center px-3 py-1 rounded-md text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200">
                  #{channel.replace('#', '')}
                </span>
              )) || (
                <span className="text-sm text-gray-500 italic">#general</span>
              )}
            </div>
          </div>
        );
      }

      case 'github': {
        const repos = integration.details.repositories as string[] | undefined;
        return (
          <div className="mt-2">
            <p className="text-sm text-gray-600 mb-1">Repositories:</p>
            <div className="flex flex-wrap gap-2">
              {repos?.map((repo, idx) => (
                <span key={idx} className="inline-flex items-center px-3 py-1 rounded-md text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                  ⌘ {repo.replace('tourbillon-', '')}
                </span>
              )) || (
                <span className="text-sm text-gray-500 italic">tourbillon-core</span>
              )}
            </div>
          </div>
        );
      }

      case 'google': {
        return null; // Google integration details shown elsewhere if needed
      }

      default:
        return null;
    }
  };

  // Helper to get icon and color for each integration type
  const getIntegrationIcon = (type: string) => {
    switch (type) {
      case 'slack':
        return { emoji: '💬', bg: 'bg-purple-100', text: 'text-purple-800' };
      case 'github':
        return { emoji: '🐙', bg: 'bg-gray-100', text: 'text-gray-800' };
      case 'google':
        return { emoji: '🔵', bg: 'bg-blue-100', text: 'text-blue-800' };
      default:
        return { emoji: '⚙️', bg: 'bg-gray-100', text: 'text-gray-800' };
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
        <div className="max-w-6xl mx-auto px-6 py-12 flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <nav className="flex items-center space-x-2 text-sm text-gray-500 mb-1">
              <Link href="/developer" className="hover:text-blue-600 transition-colors font-medium">Developer Portal</Link>
              <span>/</span>
              <span className="text-gray-900 font-semibold">My Integrations</span>
            </nav>
            <h1 className="text-2xl font-bold text-gray-900">My Integrations</h1>
            <p className="text-sm text-gray-600 mt-1">Manage your connected services and configure integrations with external platforms</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        
        {/* Overview Cards Row */}
        <section aria-label="Overview Statistics">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Overview</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* API Status Card */}
            <div className="bg-white border border-gray-200 rounded-xl p-6 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-600">API Status</h3>
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                  ● All Systems Operational
                </span>
              </div>
              <p className="text-2xl font-bold text-gray-900">Healthy</p>
              <p className="text-sm text-gray-500 mt-1">All endpoints responding normally</p>
            </div>

            {/* Integrations Card */}
            <div className="bg-white border border-gray-200 rounded-xl p-6 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-600">Integrations</h3>
                <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                  summary.connected > 0 ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                }`}>
                  {summary.connected} connected
                </span>
              </div>
              <p className="text-2xl font-bold text-gray-900">{summary.total - summary.disconnected} / {summary.total}</p>
              <p className="text-sm text-gray-500 mt-1">Services configured</p>
            </div>

            {/* Quota Usage Card */}
            <div className="bg-white border border-gray-200 rounded-xl p-6 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-600">Quota Usage</h3>
                <span className="text-xs text-gray-500">Monthly</span>
              </div>
              <p className="text-2xl font-bold text-gray-900 mb-2">3.2K / 10K</p>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className="bg-blue-600 h-2 rounded-full transition-all" 
                  style={{ width: '32%' }}
                ></div>
              </div>
              <p className="text-xs text-gray-500 mt-1">32% used · Resets in 18 days</p>
            </div>
          </div>
        </section>

        {/* Integrations Detail Section */}
        <section aria-label="Connected Services">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Connected Services</h2>
          
          {integrations.length === 0 ? (
            <div className="text-center py-16 bg-white border-2 border-dashed border-gray-300 rounded-xl">
              <div className="text-4xl mb-4">🔗</div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">No integrations configured</h3>
              <p className="text-gray-600 mb-6 max-w-md mx-auto">
                Connect your favorite services to extend the Tourbillon platform with powerful integrations.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {integrations.map((integration) => {
                const icons = getIntegrationIcon(integration.type);
                return (
                  <div
                    key={integration.id}
                    className={`bg-white border rounded-xl p-6 transition-all hover:shadow-md ${
                      !integration.connected ? 'border-gray-300 bg-gray-50 opacity-75' : 'border-gray-200'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        {/* Integration header */}
                        <div className="flex items-center space-x-3 mb-3">
                          <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-xl ${icons.bg}`}>
                            {icons.emoji}
                          </div>
                          <div>
                            <h3 className="text-lg font-semibold text-gray-900">{integration.name || integration.type.charAt(0).toUpperCase() + integration.type.slice(1)}</h3>
                            <p className={`text-sm ${
                              integration.connected ? 'text-green-600' : 'text-gray-500'
                            }`}>
                              {integration.connected ? (
                                <span className="inline-flex items-center">
                                  <span className="w-2 h-2 bg-green-500 rounded-full mr-1"></span>
                                  Active · Last used: {formatDate(new Date(Date.now() - Math.random() * 86400000))}
                                </span>
                              ) : (
                                <span className="inline-flex items-center">
                                  <span className="w-2 h-2 bg-gray-400 rounded-full mr-1"></span>
                                  Not connected
                                </span>
                              )}
                            </p>
                          </div>
                        </div>

                        {/* Integration details */}
                        {renderIntegrationDetails(integration)}

                        {/* Actions */}
                        <div className="flex items-center space-x-3 mt-4">
                          {integration.connected ? (
                            <>
                              <Link
                                href={`/${integration.type === 'slack' ? '' : integration.type}-dashboard`}
                                className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-100 hover:bg-blue-200 text-blue-800 transition-colors"
                              >
                                Configure
                              </Link>
                              <button
                                onClick={() => disconnectIntegration(integration.id, integration.type)}
                                disabled={disconnectingId === integration.id}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                                  disconnectingId === integration.id
                                    ? 'bg-gray-100 text-gray-400 cursor-wait'
                                    : 'bg-red-100 hover:bg-red-200 text-red-800'
                                }`}
                              >
                                {disconnectingId === integration.id ? 'Disconnecting...' : 'Disconnect'}
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => connectIntegration(integration.type)}
                              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                            >
                              Connect {integration.name || integration.type.charAt(0).toUpperCase() + integration.type.slice(1)}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Recent Activity */}
        <section aria-label="Recent Activity">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Activity</h2>
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            {activityItems.length === 0 ? (
              <div className="p-6 text-center text-gray-500">No recent activity</div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {activityItems.map((item) => (
                  <li key={item.id} className="px-6 py-4 flex items-start space-x-3 hover:bg-gray-50 transition-colors">
                    <span className={`w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center text-sm ${
                      item.type === 'integration' ? 'bg-purple-100 text-purple-700' :
                      item.type === 'api_key' ? 'bg-blue-100 text-blue-700' :
                      item.type === 'webhook' ? 'bg-green-100 text-green-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>
                      {item.type === 'integration' ? '🔗' :
                       item.type === 'api_key' ? '🔑' :
                       item.type === 'webhook' ? '🪝' :
                       '⚡'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900">{item.message}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{formatDate(item.timestamp)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Quick Actions */}
        <section aria-label="Quick Actions">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h2>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/developer/api-keys"
              className="px-5 py-3 bg-white border border-gray-200 rounded-xl hover:border-blue-300 hover:shadow-md transition-all text-sm font-medium text-gray-700 hover:text-blue-700 flex items-center space-x-2"
            >
              <span>🔑</span>
              <span>Generate API Key</span>
            </Link>
            <Link
              href="/developer/webhooks"
              className="px-5 py-3 bg-white border border-gray-200 rounded-xl hover:border-blue-300 hover:shadow-md transition-all text-sm font-medium text-gray-700 hover:text-blue-700 flex items-center space-x-2"
            >
              <span>🪝</span>
              <span>Add Webhook</span>
            </Link>
            <button
              onClick={() => connectIntegration('slack')}
              className="px-5 py-3 bg-white border border-gray-200 rounded-xl hover:border-purple-300 hover:shadow-md transition-all text-sm font-medium text-gray-700 hover:text-purple-700 flex items-center space-x-2"
            >
              <span>💬</span>
              <span>Connect Slack</span>
            </button>
            <Link
              href="/developer/rate-limits"
              className="px-5 py-3 bg-white border border-gray-200 rounded-xl hover:border-blue-300 hover:shadow-md transition-all text-sm font-medium text-gray-700 hover:text-blue-700 flex items-center space-x-2"
            >
              <span>⚡</span>
              <span>View Rate Limits</span>
            </Link>
          </div>
        </section>

        {/* Integration Security Notice */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-3">🔒 Integration Security</h3>
          <ul className="space-y-2 text-sm text-blue-800">
            <li>• OAuth tokens are encrypted at rest and never exposed in logs or API responses</li>
            <li>• Connections use scoped permissions — only request what's necessary for each integration</li>
            <li>• You can revoke access to any connected service at any time via the Disconnect button above</li>
            <li>• All OAuth flows are protected with CSRF tokens and state parameters</li>
            <li>• Connected services follow least-privilege access principles by default</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
