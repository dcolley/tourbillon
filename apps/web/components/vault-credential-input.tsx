'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface VaultCredentialInputProps {
  serverId: string;
  scope: 'company' | 'company_user' | 'agent';
  userId?: string;
  agentId?: string;
  configured: boolean;
  needsReauth: boolean;
  authType?: 'api_key' | 'oauth';
  label: string;
  placeholder?: string;
  description?: string;
  envFallback?: string;
}

export function VaultCredentialInput({
  serverId,
  scope,
  userId,
  agentId,
  configured,
  needsReauth,
  authType,
  label,
  placeholder,
  description,
  envFallback,
}: VaultCredentialInputProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState('');
  const [clearChecked, setClearChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const isConfigured = configured || !!envFallback;
  const showReconnect = needsReauth && authType === 'oauth';

  const handleSave = async () => {
    setError(null);
    setSuccess(null);

    try {
      if (clearChecked) {
        const response = await fetch('/api/vault/credentials', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serverId,
            scope,
            userId,
            agentId,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to delete credential');
        }

        setSuccess('Credential deleted successfully');
        setValue('');
        setClearChecked(false);
        startTransition(() => {
          router.refresh();
        });
        return;
      }

      if (value.trim()) {
        const response = await fetch('/api/vault/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serverId,
            scope,
            userId,
            agentId,
            authType: 'api_key',
            value: value.trim(),
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to save credential');
        }

        setSuccess('Credential saved successfully');
        setValue('');
        startTransition(() => {
          router.refresh();
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleOAuthConnect = () => {
    const params = new URLSearchParams({
      serverId,
      scope,
    });
    if (userId) params.set('userId', userId);
    if (agentId) params.set('agentId', agentId);

    window.location.href = `/api/vault/oauth/authorize?${params.toString()}`;
  };

  if (authType === 'oauth' && configured) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label className="text-sm font-medium">{label}</label>
          {showReconnect ? (
            <span className="text-xs rounded px-2 py-0.5 bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400">
              ⚠ Reconnect required
            </span>
          ) : (
            <span className="text-xs rounded px-2 py-0.5 bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400">
              ✓ Connected
            </span>
          )}
        </div>
        {showReconnect && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleOAuthConnect}
            disabled={isPending}
          >
            Reconnect {label}
          </Button>
        )}
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
    );
  }

  if (authType === 'oauth' && !configured) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label className="text-sm font-medium">{label}</label>
          <span className="text-xs rounded px-2 py-0.5 bg-muted text-muted-foreground">
            Not configured
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleOAuthConnect}
          disabled={isPending}
        >
          Connect {label}
        </Button>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={serverId} className="text-sm font-medium">
          {label}
        </label>
        <span
          className={`text-xs rounded px-2 py-0.5 ${
            isConfigured
              ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {isConfigured ? 'Configured' : 'Not configured'}
        </span>
      </div>
      <input
        id={serverId}
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={configured ? '••••••••' : placeholder || 'Enter API key'}
        disabled={isPending || clearChecked}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      {configured && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={clearChecked}
            onChange={(e) => setClearChecked(e.target.checked)}
            disabled={isPending}
            className="rounded border-input"
          />
          Clear stored key
        </label>
      )}
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      {success && (
        <p className="text-xs text-green-600 dark:text-green-400">{success}</p>
      )}
      {(value.trim() || clearChecked) && (
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={isPending}
        >
          {isPending ? 'Saving...' : clearChecked ? 'Delete Credential' : 'Save Credential'}
        </Button>
      )}
    </div>
  );
}
