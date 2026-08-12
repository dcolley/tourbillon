'use client';

import { useActionState, useState } from 'react';
import type { ActionResult } from '@/lib/action-result';
import { useActionToast } from '@/hooks/use-action-toast';
import { ActionSubmitButton } from '@/components/action-form';

interface ProviderOption {
  id: string;
  name: string;
  type: string;
  baseURL: string;
  isDefault: boolean;
}

interface ObservationalMemorySettingsFormProps {
  initialEnabled: boolean;
  initialProviderId: string | null;
  initialModelId: string;
  providers: ProviderOption[];
  saveAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}

export function ObservationalMemorySettingsForm({
  initialEnabled,
  initialProviderId,
  initialModelId,
  providers,
  saveAction,
}: ObservationalMemorySettingsFormProps) {
  const [state, formAction] = useActionState(saveAction, null);
  useActionToast(state);

  const defaultProviderId =
    initialProviderId ?? providers.find((p) => p.isDefault)?.id ?? providers[0]?.id ?? '';

  const [enabled, setEnabled] = useState(initialEnabled);
  const [providerId, setProviderId] = useState(defaultProviderId);
  const [modelId, setModelId] = useState(initialModelId);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const selectedProvider = providers.find((p) => p.id === providerId);

  async function loadModels() {
    if (!providerId) {
      setFetchError('Select a provider first.');
      return;
    }

    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/models?providerId=${encodeURIComponent(providerId)}`);
      const data = (await res.json()) as {
        models?: Array<{ id: string }>;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const ids = (data.models ?? []).map((m) => m.id);
      setModels(ids);
      if (ids.length === 0) {
        setFetchError('No models returned from provider.');
      }
    } catch (err) {
      setModels([]);
      setFetchError(err instanceof Error ? err.message : 'Failed to load models');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form action={formAction} className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          value="on"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="rounded border-input"
        />
        Enable Observational Memory compaction
      </label>

      <div className="space-y-1.5">
        <label htmlFor="omProviderId" className="text-sm font-medium">
          Provider
        </label>
        <select
          id="omProviderId"
          name="providerId"
          required={enabled}
          disabled={!enabled}
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            setModels([]);
            setFetchError(null);
          }}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
        >
          {providers.length === 0 ? (
            <option value="">No providers configured</option>
          ) : (
            providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} ({provider.type})
              </option>
            ))
          )}
        </select>
        {selectedProvider && (
          <p className="text-xs text-muted-foreground font-mono break-all">
            {selectedProvider.baseURL}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="omModelId" className="text-sm font-medium">
          Model ID
        </label>
        <input
          id="omModelId"
          name="modelId"
          type="text"
          required={enabled}
          disabled={!enabled}
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="meta-llama/Llama-3.3-70B-Instruct"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono disabled:opacity-50"
        />
        <p className="text-xs text-muted-foreground">
          Used for both Observer and Reflector compaction on durable Agent and harness heartbeats.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={loadModels}
          disabled={!enabled || loading || !providerId}
          className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load models from provider'}
        </button>
        {models.length > 0 && (
          <select
            disabled={!enabled}
            value={models.includes(modelId) ? modelId : ''}
            onChange={(e) => {
              if (e.target.value) setModelId(e.target.value);
            }}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono max-w-full disabled:opacity-50"
          >
            <option value="">Select a model…</option>
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        )}
      </div>

      {fetchError && <p className="text-xs text-destructive">{fetchError}</p>}

      <ActionSubmitButton label="Save Observational Memory" />
    </form>
  );
}
