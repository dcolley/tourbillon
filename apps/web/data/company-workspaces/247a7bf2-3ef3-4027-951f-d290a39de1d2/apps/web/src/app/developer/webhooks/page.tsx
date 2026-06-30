'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface WebhookEndpoint {
  id: string;
  url: string;
  active: boolean;
  events: string[];
  lastDelivered?: Date | null;
  createdAt: string; // ISO timestamp
}

export default function WebhooksPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Available event types for webhooks
  const availableEvents = [
    'feedback.submitted',
    'nps.response', 
    'user.created',
    'payment.received',
    'custom.*'
  ];

  useEffect(() => {
    fetchEndpoints();
  }, []);

  const fetchEndpoints = async () => {
    try {
      setError(null);
      const response = await fetch('/api/webhooks/endpoints');
      if (!response.ok) {
        throw new Error('Failed to fetch webhook endpoints');
      }
      const data = await response.json();
      setEndpoints(data.endpoints || []);
    } catch (error) {
      console.error('Failed to fetch webhooks:', error);
      setError('Unable to load webhook endpoints. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleAddEndpoint = async () => {
    if (!newUrl.trim() || selectedEvents.length === 0) return;
    
    try {
      setError(null);
      const response = await fetch('/api/webhooks/endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newUrl, events: selectedEvents }),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create webhook endpoint');
      }
      
      setShowAddModal(false);
      setNewUrl('');
      setSelectedEvents([]);
      fetchEndpoints(); // Refresh the list
    } catch (error) {
      console.error('Failed to add webhook:', error);
      setError(error instanceof Error ? error.message : 'Failed to create webhook endpoint');
    }
  };

  const handleToggleEndpoint = async (id: string, active: boolean) => {
    try {
      setError(null);
      const response = await fetch(`/api/webhooks/endpoints/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update webhook endpoint');
      }
      
      fetchEndpoints(); // Refresh the list
    } catch (error) {
      console.error('Failed to toggle webhook:', error);
      setError(error instanceof Error ? error.message : 'Failed to toggle webhook status');
    }
  };

  const handleDeleteEndpoint = async (id: string) => {
    if (!confirm('Are you sure you want to delete this webhook endpoint? This action cannot be undone.')) return;
    
    try {
      setError(null);
      const response = await fetch(`/api/webhooks/endpoints/${id}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete webhook endpoint');
      }
      
      fetchEndpoints(); // Refresh the list
    } catch (error) {
      console.error('Failed to delete webhook:', error);
      setError(error instanceof Error ? error.message : 'Failed to delete webhook endpoint');
    }
  };

  const handleTestEndpoint = async (id: string, url: string) => {
    try {
      setError(null);
      // Call the test endpoint with the ID in the body since it's a static route
      const response = await fetch('/api/webhooks/endpoints/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, url }),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to test webhook');
      }
      
      alert('Test payload sent successfully! Check your webhook receiver.');
      fetchEndpoints(); // Refresh the list
    } catch (error) {
      console.error('Failed to test webhook:', error);
      setError(error instanceof Error ? error.message : 'Failed to send test payload. Please check the endpoint URL and try again.');
    }
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return 'Never';
    
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      
      if (diffHours < 1) return 'Just now';
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffHours < 72) return `${Math.floor(diffHours / 24)}d ago`;
      return date.toLocaleDateString();
    } catch {
      return 'Unknown';
    }
  };

  const getEventColor = (event: string): string => {
    switch (event) {
      case 'feedback.submitted':
        return 'bg-blue-100 text-blue-800';
      case 'nps.response':
        return 'bg-purple-100 text-purple-800';
      case 'user.created':
        return 'bg-green-100 text-green-800';
      case 'payment.received':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
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
              <Link href="/developer" className="hover:text-blue-600 transition-colors">Developer Portal</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">Webhooks</span>
            </nav>
            <h1 className="text-2xl font-bold text-gray-900">Webhook Endpoints</h1>
            <p className="text-sm text-gray-600 mt-1">Configure, monitor, and test webhook endpoints for real-time event notifications</p>
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors flex items-center space-x-2"
          >
            <span>+ Add Endpoint</span>
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="max-w-6xl mx-auto px-6 py-4">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between">
            <p className="text-sm text-red-800">{error}</p>
            <button 
              onClick={() => setError(null)}
              className="text-red-600 hover:text-red-800 ml-4"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        {endpoints.length === 0 ? (
          <div className="text-center py-16 bg-white border-2 border-dashed border-gray-300 rounded-xl">
            <div className="text-4xl mb-4">🔗</div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No webhook endpoints configured</h3>
            <p className="text-gray-600 mb-6 max-w-md mx-auto">
              Create a webhook endpoint to receive real-time notifications when events occur in your application.
            </p>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
            >
              Create Your First Endpoint
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {endpoints.map((endpoint) => (
              <div
                key={endpoint.id}
                className={`bg-white border rounded-xl p-6 transition-all hover:shadow-md ${
                  !endpoint.active ? 'border-gray-300 bg-gray-50 opacity-75' : 'border-gray-200'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    {/* Endpoint URL and status */}
                    <div className="flex items-center space-x-3 mb-2">
                      <div className={`w-3 h-3 rounded-full ${endpoint.active ? 'bg-green-500' : 'bg-gray-400'}`}></div>
                      <code className={`text-lg font-mono ${!endpoint.active ? 'line-through opacity-50' : ''}`}>
                        {endpoint.url}
                      </code>
                    </div>

                    {/* Metadata */}
                    <p className="text-sm text-gray-500 mb-3">
                      Status: <span className={endpoint.active ? 'font-medium text-green-600' : 'font-medium text-gray-500'}>{endpoint.active ? 'Active' : 'Paused'}</span> 
                      • Last delivered: {formatDate(endpoint.lastDelivered || null)}
                    </p>

                    {/* Event types */}
                    <div className="flex flex-wrap gap-2 mb-4">
                      {endpoint.events.map((event) => (
                        <span key={event} className={`inline-flex items-center px-3 py-1 rounded-md text-xs font-medium ${getEventColor(event)}`}>
                          {event}
                        </span>
                      ))}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center space-x-3">
                      <button
                        onClick={() => handleTestEndpoint(endpoint.id, endpoint.url)}
                        disabled={!endpoint.active}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          !endpoint.active 
                            ? 'bg-gray-50 text-gray-400 cursor-not-allowed' 
                            : 'bg-blue-100 hover:bg-blue-200 text-blue-800'
                        }`}
                      >
                        🔍 Test Endpoint
                      </button>
                      
                      {endpoint.active ? (
                        <button
                          onClick={() => handleToggleEndpoint(endpoint.id, false)}
                          className="px-4 py-2 rounded-lg text-sm font-medium bg-orange-100 hover:bg-orange-200 text-orange-800 transition-colors"
                        >
                          ⏸️ Pause
                        </button>
                      ) : (
                        <button
                          onClick={() => handleToggleEndpoint(endpoint.id, true)}
                          className="px-4 py-2 rounded-lg text-sm font-medium bg-green-100 hover:bg-green-200 text-green-800 transition-colors"
                        >
                          ▶️ Resume
                        </button>
                      )}
                      
                      <button
                        onClick={() => handleDeleteEndpoint(endpoint.id)}
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-red-100 hover:bg-red-200 text-red-800 transition-colors"
                      >
                        🗑️ Delete
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Info Section */}
        <div className="mt-12 bg-blue-50 border border-blue-200 rounded-xl p-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-3">📚 Webhooks Documentation</h3>
          <p className="text-blue-800 mb-4">
            Webhook endpoints allow your application to receive real-time notifications when events occur. 
            When you configure an endpoint, our platform will send HTTP POST requests to that URL with event payloads.
          </p>
          
          <div className="grid md:grid-cols-2 gap-6 mt-4">
            <div>
              <h4 className="font-semibold text-blue-900 mb-2">Available Event Types</h4>
              <ul className="space-y-1 text-sm text-blue-800">
                {availableEvents.map((event) => (
                  <li key={event} className="flex items-center space-x-2">
                    <span className="font-mono bg-white px-2 py-0.5 rounded border">{event}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="font-semibold text-blue-900 mb-2">Security</h4>
              <p className="text-sm text-blue-800">
                All webhook payloads are signed with HMAC-SHA256. Include the signature in your request headers 
                for verification: <code className="bg-white px-2 py-0.5 rounded border">X-Webhook-Signature</code>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Add Endpoint Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold text-gray-900">Add Webhook Endpoint</h2>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                ✕
              </button>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); handleAddEndpoint(); }}>
              {/* URL Input */}
              <div className="mb-4">
                <label htmlFor="url" className="block text-sm font-medium text-gray-700 mb-2">
                  Endpoint URL *
                </label>
                <input
                  id="url"
                  type="url"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="https://your-app.com/hooks/tourbillon"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  required
                />
              </div>

              {/* Event Types */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Event Types *
                </label>
                <div className="space-y-2 max-h-48 overflow-y-auto border rounded-lg p-3">
                  {availableEvents.map((event) => (
                    <label key={event} className="flex items-center space-x-3 p-2 hover:bg-gray-50 rounded cursor-pointer transition-colors">
                      <input
                        type="checkbox"
                        checked={selectedEvents.includes(event)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedEvents([...selectedEvents, event]);
                          } else {
                            setSelectedEvents(selectedEvents.filter(e => e !== event));
                          }
                        }}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm">{event}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-gray-700 hover:text-gray-900 font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!newUrl || selectedEvents.length === 0}
                  className={`px-6 py-2 bg-blue-600 text-white rounded-lg font-medium transition-colors ${
                    !newUrl || selectedEvents.length === 0 
                      ? 'opacity-50 cursor-not-allowed' 
                      : 'hover:bg-blue-700'
                  }`}
                >
                  Create Endpoint
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
