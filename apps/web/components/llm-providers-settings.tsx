'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  defaultBaseURLForProviderType,
  LLM_PROVIDER_TYPE_LABELS,
  LLM_PROVIDER_TYPES,
  type LlmProviderType,
} from '@tourbillon/shared/model-provider';
import type { AgentModelSettings } from '@tourbillon/shared';
import {
  formValuesToModelSettings,
  modelSettingsToFormValues,
  ModelSettingsFields,
  type ModelSettingsFormValues,
  emptyModelSettingsFormValues,
} from '@/components/model-settings-fields';

interface LlmProviderPublic {
  id: string;
  name: string;
  type: LlmProviderType;
  baseURL: string;
  hasApiKey: boolean;
  headers: Record<string, string>;
  apiMode: 'chat' | 'responses';
  isDefault: boolean;
  defaultModelSettings: AgentModelSettings;
}

interface ProviderFormState {
  name: string;
  type: LlmProviderType;
  baseURL: string;
  apiKey: string;
  apiMode: 'chat' | 'responses';
  isDefault: boolean;
  headerRows: Array<{ key: string; value: string }>;
  modelSettings: ModelSettingsFormValues;
}

const EMPTY_FORM: ProviderFormState = {
  name: '',
  type: 'lmstudio',
  baseURL: defaultBaseURLForProviderType('lmstudio'),
  apiKey: '',
  apiMode: 'chat',
  isDefault: false,
  headerRows: [],
  modelSettings: emptyModelSettingsFormValues(),
};

function headersToRows(headers: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(headers).map(([key, value]) => ({ key, value }));
}

function rowsToHeaders(rows: Array<{ key: string; value: string }>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) headers[key] = row.value;
  }
  return headers;
}

export function LlmProvidersSettings() {
  const [providers, setProviders] = useState<LlmProviderPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/llm-providers');
      const data = (await res.json()) as { providers?: LlmProviderPublic[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setProviders(data.providers ?? []);
    } catch (err) {
      setProviders([]);
      setError(err instanceof Error ? err.message : 'Failed to load providers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  function startCreate() {
    setEditingId('new');
    setForm(EMPTY_FORM);
    setTestResult(null);
  }

  function startEdit(provider: LlmProviderPublic) {
    setEditingId(provider.id);
    setForm({
      name: provider.name,
      type: provider.type,
      baseURL: provider.baseURL,
      apiKey: '',
      apiMode: provider.apiMode,
      isDefault: provider.isDefault,
      headerRows: headersToRows(provider.headers),
      modelSettings: modelSettingsToFormValues(provider.defaultModelSettings),
    });
    setTestResult(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setTestResult(null);
  }

  async function saveProvider() {
    setSaving(true);
    setError(null);
    try {
      const defaultModelSettings = formValuesToModelSettings(form.modelSettings);
      const payload = {
        name: form.name,
        type: form.type,
        baseURL: form.baseURL,
        headers: rowsToHeaders(form.headerRows),
        apiMode: form.apiMode,
        isDefault: form.isDefault,
        defaultModelSettings,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      };

      const res = await fetch(
        editingId === 'new' ? '/api/llm-providers' : `/api/llm-providers/${editingId}`,
        {
          method: editingId === 'new' ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      cancelEdit();
      await loadProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save provider');
    } finally {
      setSaving(false);
    }
  }

  async function deleteProvider(id: string) {
    if (!confirm('Delete this provider? Agents using it must be reassigned first.')) return;
    setError(null);
    try {
      const res = await fetch(`/api/llm-providers/${id}`, { method: 'DELETE' });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (editingId === id) cancelEdit();
      await loadProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete provider');
    }
  }

  async function testProvider(id: string) {
    setTestingId(id);
    setTestResult(null);
    setError(null);
    try {
      const res = await fetch(`/api/models?providerId=${encodeURIComponent(id)}`);
      const data = (await res.json()) as { models?: Array<{ id: string }>; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const count = data.models?.length ?? 0;
      setTestResult(`${count} model${count === 1 ? '' : 's'} found`);
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setTestingId(null);
    }
  }

  async function testFormProvider() {
    if (editingId === 'new') {
      setError('Save the provider first, then test the connection.');
      return;
    }
    if (editingId) await testProvider(editingId);
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">LLM Providers</h2>
          <p className="text-sm text-muted-foreground">
            System-wide model endpoints. Agents select a provider, then pick a model from that endpoint.
          </p>
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          Add provider
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading providers…</p>
      ) : providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No providers configured yet.</p>
      ) : (
        <div className="border rounded-lg divide-y text-sm">
          {providers.map((provider) => (
            <div key={provider.id} className="p-3 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {provider.name}
                    {provider.isDefault && (
                      <span className="ml-2 text-xs rounded-full bg-primary/10 text-primary px-2 py-0.5">
                        Default
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {LLM_PROVIDER_TYPE_LABELS[provider.type]} · {provider.baseURL}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => testProvider(provider.id)}
                    disabled={testingId === provider.id}
                    className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                  >
                    {testingId === provider.id ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(provider)}
                    className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteProvider(provider.id)}
                    className="rounded-md border px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                API key: {provider.hasApiKey ? 'set' : 'none'} · Headers:{' '}
                {Object.keys(provider.headers).length || 'none'} · Mode: {provider.apiMode}
              </p>
            </div>
          ))}
        </div>
      )}

      {testResult && !editingId && (
        <p className="text-xs text-muted-foreground">Last test: {testResult}</p>
      )}

      {editingId && (
        <div className="border rounded-lg p-4 space-y-4">
          <h3 className="text-sm font-semibold">
            {editingId === 'new' ? 'New provider' : 'Edit provider'}
          </h3>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Local LM Studio"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Type</label>
              <select
                value={form.type}
                onChange={(e) => {
                  const type = e.target.value as LlmProviderType;
                  setForm((f) => ({
                    ...f,
                    type,
                    baseURL: f.baseURL || defaultBaseURLForProviderType(type),
                  }));
                }}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {LLM_PROVIDER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {LLM_PROVIDER_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-sm font-medium">Base URL</label>
              <input
                type="url"
                value={form.baseURL}
                onChange={(e) => setForm((f) => ({ ...f, baseURL: e.target.value }))}
                placeholder="http://localhost:1234/v1"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">API key</label>
              <input
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder={editingId === 'new' ? 'Optional' : 'Leave blank to keep existing'}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              />
              <p className="text-xs text-muted-foreground">Sent as Bearer token when set.</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">API mode</label>
              <select
                value={form.apiMode}
                onChange={(e) =>
                  setForm((f) => ({ ...f, apiMode: e.target.value as 'chat' | 'responses' }))
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="chat">Chat completions</option>
                <option value="responses">Responses API</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Additional headers</label>
              <button
                type="button"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    headerRows: [...f.headerRows, { key: '', value: '' }],
                  }))
                }
                className="text-xs rounded-md border px-2 py-1 hover:bg-muted"
              >
                Add header
              </button>
            </div>
            {form.headerRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No extra headers.</p>
            ) : (
              <div className="space-y-2">
                {form.headerRows.map((row, index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      type="text"
                      value={row.key}
                      onChange={(e) =>
                        setForm((f) => {
                          const headerRows = [...f.headerRows];
                          headerRows[index] = { ...headerRows[index], key: e.target.value };
                          return { ...f, headerRows };
                        })
                      }
                      placeholder="Header name"
                      className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                    />
                    <input
                      type="text"
                      value={row.value}
                      onChange={(e) =>
                        setForm((f) => {
                          const headerRows = [...f.headerRows];
                          headerRows[index] = { ...headerRows[index], value: e.target.value };
                          return { ...f, headerRows };
                        })
                      }
                      placeholder="Value"
                      className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          headerRows: f.headerRows.filter((_, i) => i !== index),
                        }))
                      }
                      className="rounded-md border px-2 text-xs hover:bg-muted"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Default generation settings
            </summary>
            <div className="mt-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Agents using this provider inherit these values unless overridden on the agent.
                Leave fields blank to defer to the endpoint&apos;s own defaults.
              </p>
              <ModelSettingsFields
                values={form.modelSettings}
                onChange={(modelSettings) => setForm((f) => ({ ...f, modelSettings }))}
                showAdvanced
              />
            </div>
          </details>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
              className="rounded border-input"
            />
            Default provider for new agents
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveProvider}
              disabled={saving}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save provider'}
            </button>
            {editingId !== 'new' && (
              <button
                type="button"
                onClick={testFormProvider}
                disabled={testingId === editingId}
                className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {testingId === editingId ? 'Testing…' : 'Test connection'}
              </button>
            )}
            <button
              type="button"
              onClick={cancelEdit}
              className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
          </div>

          {testResult && editingId && (
            <p className="text-xs text-muted-foreground">Test result: {testResult}</p>
          )}
        </div>
      )}
    </section>
  );
}
