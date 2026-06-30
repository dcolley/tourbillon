'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface TokenInfo {
  type: string; // session, access, refresh
  issuedAt: Date;
  expiresAt: Date;
  expiresInMs: number; // time until expiry in milliseconds
  status: 'valid' | 'expiring_soon' | 'expired';
  lastRefresh?: Date;
}

export default function TokenExpiryPage() {
  const [tokens, setTokens] = useState<TokenInfo[]>([
    {
      type: 'Session',
      issuedAt: new Date(Date.now() - 3600000), // 1 hour ago
      expiresAt: new Date(Date.now() + 7200000), // 2 hours from now
      expiresInMs: 7200000,
      status: 'valid',
    },
    {
      type: 'Access Token',
      issuedAt: new Date(Date.now() - 600000), // 10 minutes ago
      expiresAt: new Date(Date.now() + 35400000), // ~10 hours from now
      expiresInMs: 35400000,
      status: 'valid',
    },
    {
      type: 'Refresh Token',
      issuedAt: new Date(Date.now() - 86400000), // 1 day ago
      expiresAt: new Date(Date.now() + 2592000000), // 30 days from now
      expiresInMs: 2592000000,
      status: 'valid',
    },
  ]);

  const [refreshing, setRefreshing] = useState<string | null>(null);
  const router = useRouter();

  const handleRefreshToken = async (tokenType: string) => {
    setRefreshing(tokenType);
    
    try {
      // In production, this would call an API endpoint to refresh the token
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Update the token info after refresh
      setTokens(prevTokens => prevTokens.map(token => 
        token.type === tokenType 
          ? { ...token, issuedAt: new Date(), lastRefresh: new Date() }
          : token
      ));
    } catch (error) {
      console.error(`Failed to refresh ${tokenType}:`, error);
    } finally {
      setRefreshing(null);
    }
  };

  const handleLogout = async () => {
    try {
      // In production, this would call the logout API endpoint
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/'); // Redirect to home page after logout
    } catch (error) {
      console.error('Failed to logout:', error);
    }
  };

  const formatTimeRemaining = (expiresInMs: number): string => {
    if (expiresInMs <= 0) return 'Expired';
    
    const days = Math.floor(expiresInMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((expiresInMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((expiresInMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'valid':
        return 'text-green-600 bg-green-100';
      case 'expiring_soon':
        return 'text-yellow-600 bg-yellow-100';
      case 'expired':
        return 'text-red-600 bg-red-100';
      default:
        return 'text-gray-600 bg-gray-100';
    }
  };

  const getStatusIcon = (status: string): string => {
    switch (status) {
      case 'valid':
        return '🟢';
      case 'expiring_soon':
        return '🟡';
      case 'expired':
        return '🔴';
      default:
        return '⚪';
    }
  };

  const getProgressWidth = (expiresInMs: number): string => {
    if (expiresInMs <= 0) return 'w-full bg-red-500';
    
    // Assuming max token lifetime of 30 days for progress bar visualization
    const maxLifetime = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
    const remainingPercentage = (expiresInMs / maxLifetime) * 100;
    
    if (remainingPercentage < 10) return 'w-[10%] bg-red-500';
    if (remainingPercentage < 25) return 'w-[25%] bg-yellow-500';
    return `w-[${Math.min(remainingPercentage, 90)}%] bg-green-500`;
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
              <span className="text-gray-900 font-medium">Tokens</span>
            </nav>
            <h1 className="text-2xl font-bold text-gray-900">Token Expiry</h1>
            <p className="text-sm text-gray-600 mt-1">Monitor session tokens, expiry schedules, and refresh mechanics</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Token Cards Column */}
          <div className="lg:col-span-2 space-y-4">
            {tokens.map((token) => (
              <div key={token.type} className={`bg-white border rounded-xl p-6 transition-all hover:shadow-md ${
                token.status === 'expired' ? 'border-red-200 bg-red-50 opacity-75' : 'border-gray-200'
              }`}>
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{token.type}</h3>
                    <p className="text-sm text-gray-500 mt-1">Issued: {token.issuedAt.toLocaleString()}</p>
                  </div>
                  <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(token.status)}`}>
                    {getStatusIcon(token.status)} {token.status.replace('_', ' ').toUpperCase()}
                  </span>
                </div>

                {/* Expiry Progress Bar */}
                <div className="mb-4">
                  <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                    <div className={`h-3 transition-all duration-500 ${getProgressWidth(token.expiresInMs)}`}></div>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">Expires in: {formatTimeRemaining(token.expiresInMs)}</p>
                </div>

                {/* Actions */}
                <div className="flex items-center space-x-3">
                  {!refreshing && (
                    <button 
                      onClick={() => handleRefreshToken(token.type)}
                      disabled={token.status === 'expired'}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        token.status === 'expired'
                          ? 'bg-gray-50 text-gray-400 cursor-not-allowed'
                          : 'bg-blue-100 hover:bg-blue-200 text-blue-800'
                      }`}
                    >
                      🔄 Refresh Token
                    </button>
                  )}
                  {refreshing === token.type && (
                    <div className="flex items-center space-x-2">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                      <span className="text-sm text-gray-500">Refreshing...</span>
                    </div>
                  )}
                </div>

                {token.lastRefresh && (
                  <p className="text-xs text-gray-400 mt-2">Last refreshed: {token.lastRefresh.toLocaleString()}</p>
                )}
              </div>
            ))}
          </div>

          {/* Info Column */}
          <div className="space-y-6">
            <div className="bg-white border rounded-xl p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Token Management</h3>
              
              <div className="space-y-4">
                <div className="flex items-start space-x-3">
                  <span className="text-blue-500 mt-1">🔐</span>
                  <div>
                    <h4 className="font-medium text-gray-900">Session Token</h4>
                    <p className="text-sm text-gray-600">Maintains your login session. Expires after 2 hours of inactivity.</p>
                  </div>
                </div>

                <div className="flex items-start space-x-3">
                  <span className="text-purple-500 mt-1">🔑</span>
                  <div>
                    <h4 className="font-medium text-gray-900">Access Token</h4>
                    <p className="text-sm text-gray-600">Used for API authentication. Expires after 24 hours.</p>
                  </div>
                </div>

                <div className="flex items-start space-x-3">
                  <span className="text-green-500 mt-1">🔄</span>
                  <div>
                    <h4 className="font-medium text-gray-900">Refresh Token</h4>
                    <p className="text-sm text-gray-600">Used to obtain new access tokens without re-authentication. Expires after 30 days.</p>
                  </div>
                </div>
              </div>

              <button 
                onClick={handleLogout}
                className="mt-6 w-full bg-red-100 hover:bg-red-200 text-red-800 rounded-lg py-2 font-medium transition-colors"
              >
                Logout All Sessions
              </button>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-blue-900 mb-3">💡 Security Tips</h3>
              <ul className="space-y-2 text-sm text-blue-800">
                <li>• Refresh tokens regularly to maintain secure sessions</li>
                <li>• Log out from devices you no longer use</li>
                <li>• Monitor token expiry and refresh before expiration</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Auto-refresh notice */}
      <div className="max-w-6xl mx-auto px-6 pb-8">
        <p className="text-xs text-gray-500 text-center">
          Tokens are automatically refreshed when approaching expiry. 
          Manually refresh only if needed.
        </p>
      </div>
    </main>
  );
}
