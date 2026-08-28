'use client';

import { useActionState, useState } from 'react';
import type { ActionResult } from '@/lib/action-result';
import { useActionToast } from '@/hooks/use-action-toast';
import { ActionSubmitButton } from '@/components/action-form';
import type { ObservationalMemorySettings } from '@tourbillon/shared';

interface ProviderOption {
  id: string;
  name: string;
  type: string;
  baseURL: string;
  isDefault: boolean;
}

type OmMode = 'inherit' | 'off' | 'on';

interface AgentOmSettingsFormProps {
  agentId: string;
  urlKey: string;
  initialMode: OmMode;
  initialProviderId: string | null;
  initialModelId: string;
  initialMaxOutputTokens: number | null;
  initialObserveAfterTokens: number | null;
  initialReflectAfterTokens: number | null;
  initialTemperature: number | null;
  companyOm: ObservationalMemorySettings | null;
  providers: ProviderOption[];
  saveAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}

export function AgentOmSettingsForm({
  agentId,
  urlKey,
  initialMode,
  initialProviderId,
  initialModelId,
  initialMaxOutputTokens,
  initialObserveAfterTokens,
  initialReflectAfterTokens,
  initialTemperature,
  companyOm,
  providers,
  saveAction,
}: AgentOmSettingsFormProps) {
  const [state, formAction] = useActionState(saveAction, null);
  useActionToast(state);

  const [mode, setMode] = useState<OmMode>(initialMode);
  const [providerId, setProviderId] = useState(initialProviderId ?? '');
  const [modelId, setModelId] = useState(initialModelId);
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    initialMaxOutputTokens?.toString() ?? '',
  );
  const [observeAfterTokens, setObserveAfterTokens] = useState(
    initialObserveAfterTokens?.toString() ?? '',
  );
  const [reflectAfterTokens, setReflectAfterTokens] = useState(
    initialReflectAfterTokens?.toString() ?? '',
  );
  const [temperature, setTemperature] = useState(initialTemperature?.toString() ?? '');
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

  const companyOmOn = companyOm?.enabled && companyOm.providerId && companyOm.modelId;
  const companyProviderName = companyOmOn
    ? providers.find((p) => p.id === companyOm.providerId)?.name ?? 'Unknown'
    : null;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="urlKey" value={urlKey} />

      <div className="space-y-1.5">
        <label className="text-sm font-medium">Mode</label>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="mode"
              value="inherit"
              checked={mode === 'inherit'}
              onChange={(e) => e.target.checked && setMode('inherit')}
              className="mt-0.5 rounded-full border-input"
            />
            <div>
              <div>Company default</div>
              <div className="text-xs text-muted-foreground">
                {companyOmOn
                  ? `OM is on (${companyProviderName} / ${companyOm.modelId})`
                  : 'OM is off'}
              </div>
            </div>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="mode"
              value="off"
              checked={mode === 'off'}
              onChange={(e) => e.target.checked && setMode('off')}
              className="rounded-full border-input"
            />
            Off
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="mode"
              value="on"
              checked={mode === 'on'}
              onChange={(e) => e.target.checked && setMode('on')}
              className="rounded-full border-input"
            />
            On (with overrides)
          </label>
        </div>
      </div>

      {mode === 'inherit' && companyOmOn && (
        <div className="border rounded-md p-3 bg-muted/30 space-y-1 text-xs">
          <div>
            <span className="font-medium">Provider:</span> {companyProviderName}
          </div>
          <div>
            <span className="font-medium">Model:</span> {companyOm.modelId}
          </div>
          <div>
            <span className="font-medium">Max output tokens:</span>{' '}
            {companyOm.maxOutputTokens ?? 8192}
          </div>
          <div>
            <span className="font-medium">Observe after:</span>{' '}
            {companyOm.observeAfterTokens ?? 30000} tokens
          </div>
          <div>
            <span className="font-medium">Reflect after:</span>{' '}
            {companyOm.reflectAfterTokens ?? 40000} tokens
          </div>
          {companyOm.temperature !== undefined && (
            <div>
              <span className="font-medium">Temperature:</span> {companyOm.temperature}
            </div>
          )}
        </div>
      )}

      {mode === 'on' && (
        <>
          <div className="space-y-1.5">
            <label htmlFor="agentOmProviderId" className="text-sm font-medium">
              Provider
            </label>
            <select
              id="agentOmProviderId"
              name="providerId"
              value={providerId}
              onChange={(e) => {
                setProviderId(e.target.value);
                setModels([]);
                setFetchError(null);
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">
                {companyOm?.providerId ? 'Inherit from company' : 'Select provider…'}
              </option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} ({provider.type})
                </option>
              ))}
            </select>
            {selectedProvider && (
              <p className="text-xs text-muted-foreground font-mono break-all">
                {selectedProvider.baseURL}
              </p>
            )}
            {!providerId && companyOm?.providerId && (
              <p className="text-xs text-muted-foreground">
                Will inherit from company: {companyProviderName}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="agentOmModelId" className="text-sm font-medium">
              Model ID
            </label>
            <input
              id="agentOmModelId"
              name="modelId"
              type="text"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder={companyOm?.modelId || 'meta-llama/Llama-3.3-70B-Instruct'}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
            <p className="text-xs text-muted-foreground">
              {!modelId && companyOm?.modelId
                ? `Will inherit from company: ${companyOm.modelId}`
                : 'Used for both Observer and Reflector compaction.'}
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
                {models.map((id: string) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}
          </div>

          {fetchError && <p className="text-xs text-destructive">{fetchError}</p>}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="agentOmMaxOutputTokens" className="text-sm font-medium">
                Max output tokens
              </label>
              <input
                id="agentOmMaxOutputTokens"
                name="maxOutputTokens"
                type="number"
                min="1024"
                value={maxOutputTokens}
                onChange={(e) => setMaxOutputTokens(e.target.value)}
                placeholder={(companyOm?.maxOutputTokens ?? 8192).toString()}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {!maxOutputTokens
                  ? `Will inherit from company: ${companyOm?.maxOutputTokens ?? 8192}`
                  : 'Min: 1024'}
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="agentOmTemperature" className="text-sm font-medium">
                Temperature
              </label>
              <input
                id="agentOmTemperature"
                name="temperature"
                type="number"
                step="0.01"
                min="0"
                max="2"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder={companyOm?.temperature?.toString() ?? 'Provider default'}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {!temperature
                  ? companyOm?.temperature !== undefined
                    ? `Will inherit from company: ${companyOm.temperature}`
                    : 'Will use provider default'
                  : '0–2'}
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="agentOmObserveAfter" className="text-sm font-medium">
                Observe after (tokens)
              </label>
              <input
                id="agentOmObserveAfter"
                name="observeAfterTokens"
                type="number"
                min="8000"
                value={observeAfterTokens}
                onChange={(e) => setObserveAfterTokens(e.target.value)}
                placeholder={(companyOm?.observeAfterTokens ?? 30000).toString()}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {!observeAfterTokens
                  ? `Will inherit from company: ${companyOm?.observeAfterTokens ?? 30000}`
                  : 'Min: 8000'}
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="agentOmReflectAfter" className="text-sm font-medium">
                Reflect after (tokens)
              </label>
              <input
                id="agentOmReflectAfter"
                name="reflectAfterTokens"
                type="number"
                min="8000"
                value={reflectAfterTokens}
                onChange={(e) => setReflectAfterTokens(e.target.value)}
                placeholder={(companyOm?.reflectAfterTokens ?? 40000).toString()}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {!reflectAfterTokens
                  ? `Will inherit from company: ${companyOm?.reflectAfterTokens ?? 40000}`
                  : 'Min: 8000'}
              </p>
            </div>
          </div>
        </>
      )}

      <ActionSubmitButton label="Save Observational Memory" />
    </form>
  );
}
