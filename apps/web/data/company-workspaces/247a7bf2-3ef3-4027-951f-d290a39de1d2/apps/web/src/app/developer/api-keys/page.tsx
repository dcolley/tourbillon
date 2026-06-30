'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface ApiKey {
  id: string;
  name?: string;
  prefix: string; // e.g., "sk_live_" or "pk_live_"
  maskedKey: string; // e.g., "4eC39H..." (first 8 chars shown)
  fullKey?: string;
  createdAt: Date;
  lastUsedAt?: Date | null;
  permissions: string[];
  environment: 'live' | 'test';
  active: boolean;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  
  // Create key form state
  const [newKeyName, setNewKeyName] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [keyEnvironment, setKeyEnvironment] = useState<'live' | 'test'>('test');

  useEffect(() => {
    fetchApiKeys();
  }, []);

  const fetchApiKeys = async () => {
    try {
      const res = await fetch('/api/keys');
      const data = await res.json();
      setKeys(data.keys || []);
    } catch (error) {
      console.error('Failed to fetch API keys:', error);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async (key: string, id: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  const createApiKey = async () => {
    if (!newKeyName.trim()) return;
    
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newKeyName,
          permissions: selectedPermissions,
          environment: keyEnvironment,
        }),
      });
      
      const data = await res.json();
      
      // Show the newly created full key to user (only shown once)
      if (data.key) {
        alert('Your API key is: ' + data.key + '\n\nSave this securely! It will not be shown again.');
      }
      
      setShowCreateModal(false);
      setNewKeyName('');
      setSelectedPermissions([]);
      fetchApiKeys();
    } catch (error) {
      console.error('Failed to create API key:', error);
    }
  };

  const rotateApiKey = async (id: string) => {
    if (!confirm('Are you sure you want to rotate this key? The old key will be invalidated.')) return;
    
    try {
      await fetch('/api/keys/' + id + '/rotate', { method: 'POST' });
      
      // Show the new full key (only shown once)
      alert('API key rotated successfully. Your new key has been generated.');
      fetchApiKeys();
    } catch (error) {
      console.error('Failed to rotate API key:', error);
    }
  };

  const revokeApiKey = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this key? It will no longer work.')) return;
    
    try {
      await fetch('/api/keys/' + id, { method: 'DELETE' });
      fetchApiKeys();
    } catch (error) {
      console.error('Failed to revoke API key:', error);
    }
  };

  const toggleKeyStatus = async (id: string, active: boolean) => {
    try {
      await fetch('/api/keys/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      fetchApiKeys();
    } catch (error) {
      console.error('Failed to toggle key:', error);
    }
  };

  const formatDate = (date?: Date | null): string => {
    if (!date) return 'Never used';
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    
    if (diffHours < 1) return 'Just now';
    if (diffHours < 24) return diffHours + 'h ago';
    if (diffHours < 72) return Math.floor(diffHours / 24) + 'd ago';
    return date.toLocaleDateString();
  };

  const allPermissions = ['Goals', 'Issues', 'Projects', 'Tokens', 'Read-only'];

  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <nav className="flex items-center space-x-2 text-sm text-gray-500 mb-1">
              <Link href="/developer" className="hover:text-blue-600 transition-colors">Developer Portal</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">API Keys</span>
            </nav>
            <h1 className="text-2xl font-bold text-gray-900">API Keys</h1>
            <p className="text-sm text-gray-600 mt-1">Manage your API keys for accessing the Tourbillon platform programmatically</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors flex items-center space-x-2"
          >
            <span>+ New Key</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          </div>
        ) : keys.length === 0 ? (
          <div className="text-center py-16 bg-white border-2 border-dashed border-gray-300 rounded-xl">
            <div className="text-4xl mb-4">🔑</div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No API keys configured</h3>
            <p className="text-gray-600 mb-6 max-w-md mx-auto">
              Create an API key to access the Tourbillon platform programmatically through our REST APIs.
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
            >
              Create Your First Key
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {keys.map((key) => (
              <div
                key={key.id}
                className={`bg-white border rounded-xl p-6 transition-all hover:shadow-md ${
                  !key.active ? 'border-gray-300 bg-gray-50 opacity-75' : 'border-gray-200'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    {/* Key display with masking */}
                    <div className="flex items-center space-x-3 mb-2">
                      <div className={`px-2 py-1 rounded text-xs font-bold ${
                        key.prefix.startsWith('sk_') ? 'bg-purple-100 text-purple-800' : 'bg-green-100 text-green-800'
                      }`}>
                        {key.environment === 'live' ? 'LIVE' : 'TEST'}
                      </div>
                      <code className={`text-lg font-mono ${!key.active ? 'line-through opacity-50' : ''}`}>
                        {key.prefix}{key.maskedKey}...
                      </code>
                    </div>

                    {/* Key metadata */}
                    <p className="text-sm text-gray-500 mb-3">
                      {formatDate(key.lastUsedAt)} • Created: {key.createdAt.toLocaleDateString()}
                      {key.name && ' • ' + key.name}
                    </p>

                    {/* Permissions */}
                    <div className="flex flex-wrap gap-2 mb-4">
                      {key.permissions.map((permission) => (
                        <span key={permission} className="inline-flex items-center px-3 py-1 rounded-md text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                          {permission}
                        </span>
                      ))}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center space-x-3">
                      <button
                        onClick={() => copyToClipboard(key.fullKey || key.maskedKey, key.id)}
                        disabled={!key.active}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center space-x-1 ${
                          !key.active 
                            ? 'bg-gray-50 text-gray-400 cursor-not-allowed' 
                            : copiedId === key.id
                              ? 'bg-green-100 text-green-800'
                              : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                        }`}
                      >
                        <span>{copiedId === key.id ? '✓ Copied!' : '📋 Copy'}</span>
                      </button>
                      
                      {key.active && (
                        <>
                          <button
                            onClick={() => rotateApiKey(key.id)}
                            className="px-4 py-2 rounded-lg text-sm font-medium bg-yellow-100 hover:bg-yellow-200 text-yellow-800 transition-colors"
                          >
                            🔑 Rotate
                          </button>
                          <button
                            onClick={() => toggleKeyStatus(key.id, false)}
                            className="px-4 py-2 rounded-lg text-sm font-medium bg-orange-100 hover:bg-orange-200 text-orange-800 transition-colors"
                          >
                            ⏸️ Disable
                          </button>
                        </>
                      )}
                      
                      {!key.active && (
                        <button
                          onClick={() => toggleKeyStatus(key.id, true)}
                          className="px-4 py-2 rounded-lg text-sm font-medium bg-green-100 hover:bg-green-200 text-green-800 transition-colors"
                        >
                          ▶️ Enable
                        </button>
                      )}
                      
                      <button
                        onClick={() => revokeApiKey(key.id)}
                        disabled={key.active && key.environment === 'live'}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          !key.active || key.environment !== 'test'
                            ? 'bg-red-100 hover:bg-red-200 text-red-800' 
                            : 'bg-gray-50 text-gray-400 cursor-not-allowed'
                        }`}
                      >
                        🗑️ Revoke
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Security Notice */}
        <div className="mt-12 bg-yellow-50 border border-yellow-200 rounded-xl p-6">
          <h3 className="text-lg font-semibold text-yellow-900 mb-3">🔒 Security Best Practices</h3>
          <ul className="space-y-2 text-sm text-yellow-800">
            <li>• Keep your API keys secret — they provide full access to your account</li>
            <li>• Use environment variables to store keys, never commit them to version control</li>
            <li>• Rotate keys regularly and immediately if you suspect compromise</li>
            <li>• Use test environment keys during development</li>
            <li>• Follow the principle of least privilege when assigning permissions</li>
          </ul>
        </div>
      </div>

      {/* Create Key Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold text-gray-900">Create API Key</h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                ✕
              </button>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); createApiKey(); }}>
              {/* Key Name */}
              <div className="mb-4">
                <label htmlFor="keyName" className="block text-sm font-medium text-gray-700 mb-2">
                  Key Label (optional)
                </label>
                <input
                  id="keyName"
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="e.g., Production API Key, CI/CD Pipeline"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                />
              </div>

              {/* Environment */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Environment</label>
                <div className="flex space-x-4">
                  <label className={`flex items-center px-4 py-3 border rounded-lg cursor-pointer flex-1 justify-center ${
                    keyEnvironment === 'test' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
                  }`}>
                    <input
                      type="radio"
                      name="environment"
                      value="test"
                      checked={keyEnvironment === 'test'}
                      onChange={() => setKeyEnvironment('test')}
                      className="sr-only"
                    />
                    <span className={`text-sm font-medium ${keyEnvironment === 'test' ? 'text-blue-700' : 'text-gray-600'}`}>
                      Test Environment
                    </span>
                  </label>
                  <label className={`flex items-center px-4 py-3 border rounded-lg cursor-pointer flex-1 justify-center ${
                    keyEnvironment === 'live' ? 'border-purple-500 bg-purple-50' : 'border-gray-200 hover:bg-gray-50'
                  }`}>
                    <input
                      type="radio"
                      name="environment"
                      value="live"
                      checked={keyEnvironment === 'live'}
                      onChange={() => setKeyEnvironment('live')}
                      className="sr-only"
                    />
                    <span className={`text-sm font-medium ${keyEnvironment === 'live' ? 'text-purple-700' : 'text-gray-600'}`}>
                      Live Environment
                    </span>
                  </label>
                </div>
              </div>

              {/* Permissions */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">Permissions</label>
                <div className="space-y-2 max-h-48 overflow-y-auto border rounded-lg p-3">
                  {allPermissions.map((permission) => (
                    <label key={permission} className="flex items-center space-x-3 p-2 hover:bg-gray-50 rounded cursor-pointer transition-colors">
                      <input
                        type="checkbox"
                        checked={selectedPermissions.includes(permission)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedPermissions([...selectedPermissions, permission]);
                          } else {
                            setSelectedPermissions(selectedPermissions.filter(p => p !== permission));
                          }
                        }}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm">{permission}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-gray-700 hover:text-gray-900 font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={selectedPermissions.length === 0}
                  className={`px-6 py-2 rounded-lg font-medium transition-colors ${
                    selectedPermissions.length === 0 
                      ? 'bg-blue-300 text-white cursor-not-allowed' 
                      : keyEnvironment === 'live'
                        ? 'bg-purple-600 hover:bg-purple-700 text-white'
                        : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }`}
                >
                  {keyEnvironment === 'live' ? 'Create Live Key' : 'Create Test Key'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
