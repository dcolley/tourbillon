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

interface ConciergeModelSettingsFormProps {
  initialProviderId: string;
  initialModelId: string;
  /** CONCIERGE-PARAMS: the model's real window / output reserve (empty = provider default). */
  initialParams?: { maxContextTokens?: number; maxOutputTokens?: number };
  providers: ProviderOption[];
  saveAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}

/**
 * CONCIERGE-MODEL-1: pick the provider + model Assistant free-chat (AgentController) runs use
 * when no thread model choice or `?modelId=` override is present. Selecting "No concierge
 * model" and saving restores the pre-story behaviour (each agent's own model).
 */
export function ConciergeModelSettingsForm({
  initialProviderId,
  initialModelId,
  initialParams,
  providers,
  saveAction,
}: ConciergeModelSettingsFormProps) {
  const [state, formAction] = useActionState(saveAction, null);
  useActionToast(state);

  const [providerId, setProviderId] = useState(initialProviderId);
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
      <div className="space-y-1.5">
        <label htmlFor="conciergeProviderId" className="text-sm font-medium">
          Concierge model
        </label>
        <select
          id="conciergeProviderId"
          name="providerId"
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            setModels([]);
            setFetchError(null);
            if (!e.target.value) setModelId('');
          }}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">No concierge model (each agent uses its own model)</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} ({provider.type})
              {provider.isDefault ? ' · default' : ''}
            </option>
          ))}
        </select>
        {selectedProvider && (
          <p className="text-xs text-muted-foreground font-mono break-all">
            {selectedProvider.baseURL}
          </p>
        )}
      </div>

      {providerId && (
        <div className="space-y-1.5">
          <label htmlFor="conciergeModelId" className="text-sm font-medium">
            Model ID
          </label>
          <input
            id="conciergeModelId"
            name="modelId"
            type="text"
            required
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder="gpt-5.4-mini"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Text-only front-desk work: todos, lookups, progress Q&amp;A, delegation. Vision/OCR
            and other media keep using their own providers. A thread&apos;s own model choice (or
            a `?modelId=` override) still wins over this default.
          </p>
        </div>
      )}

      {providerId && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={loadModels}
            disabled={loading}
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
      )}

      {providerId && (
        <div className="space-y-1.5">
          <span className="text-sm font-medium">Context budget (tokens)</span>
          <div className="flex gap-2">
            <label className="flex-1 space-y-1 text-sm">
              <span className="text-xs text-muted-foreground">Max context (window)</span>
              <input
                name="params.maxContextTokens"
                type="number"
                step="1"
                min="8000"
                max="1048576"
                defaultValue={initialParams?.maxContextTokens ? String(initialParams.maxContextTokens) : ''}
                placeholder="e.g. 65536"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              />
            </label>
            <label className="flex-1 space-y-1 text-sm">
              <span className="text-xs text-muted-foreground">Max output (reserve)</span>
              <input
                name="params.maxOutputTokens"
                type="number"
                step="1"
                min="1024"
                max="131072"
                defaultValue={initialParams?.maxOutputTokens ? String(initialParams.maxOutputTokens) : ''}
                placeholder="e.g. 2048"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Optional. Set the model&apos;s real window when the provider default is larger — e.g.
            65536 for Qwen3.6-35B-A3B. Sizes the free-chat context budget (CTX meter limit,
            TokenLimiter trim, output reserve) so long chats trim before the provider rejects
            the prompt. Blank uses the provider default / env limit.
          </p>
        </div>
      )}

      {fetchError && <p className="text-xs text-destructive">{fetchError}</p>}

      <ActionSubmitButton label="Save concierge model" />
    </form>
  );
}
