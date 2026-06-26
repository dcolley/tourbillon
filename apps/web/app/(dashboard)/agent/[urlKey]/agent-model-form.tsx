'use client';

import { useState } from 'react';

interface ProviderOption {
  id: string;
  name: string;
  type: string;
  baseURL: string;
  isDefault: boolean;
}

interface AgentModelFormProps {
  agentId: string;
  urlKey: string;
  initialModelId: string;
  initialProviderId: string | null;
  providers: ProviderOption[];
  updateModel: (formData: FormData) => Promise<void>;
}

export function AgentModelForm({
  agentId,
  urlKey,
  initialModelId,
  initialProviderId,
  providers,
  updateModel,
}: AgentModelFormProps) {
  const defaultProviderId =
    initialProviderId ?? providers.find((p) => p.isDefault)?.id ?? providers[0]?.id ?? '';

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
    <form action={updateModel} className="space-y-4">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="urlKey" value={urlKey} />

      <div className="space-y-1.5">
        <label htmlFor="providerId" className="text-sm font-medium">
          Provider
        </label>
        <select
          id="providerId"
          name="providerId"
          required
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            setModels([]);
            setFetchError(null);
          }}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
        <label htmlFor="modelId" className="text-sm font-medium">
          Model ID
        </label>
        <input
          id="modelId"
          name="modelId"
          type="text"
          required
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="meta-llama/Llama-3.3-70B-Instruct"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
        />
        <p className="text-xs text-muted-foreground">
          Must match the model identifier exposed by the selected provider endpoint.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={loadModels}
          disabled={loading || !providerId}
          className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load models from provider'}
        </button>
        {models.length > 0 && (
          <select
            value={models.includes(modelId) ? modelId : ''}
            onChange={(e) => {
              if (e.target.value) setModelId(e.target.value);
            }}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono max-w-full"
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

      {models.length > 0 && !fetchError && (
        <p className="text-xs text-muted-foreground">
          {models.length} model{models.length === 1 ? '' : 's'} loaded — pick from the list or edit
          the text field directly.
        </p>
      )}

      <button
        type="submit"
        className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
      >
        Save model
      </button>
    </form>
  );
}
