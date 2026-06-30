import { redirect } from 'next/navigation';
import { getActiveCompany, updateCompanySettings, updateCompanyIntegrations } from '@/lib/company';
import { resolveModelProviderConfig, parseCompanySettings, isSearxngConfigured } from '@tourbillon/shared';
import { LlmProvidersSettings } from '@/components/llm-providers-settings';

async function saveSettings(formData: FormData) {
  'use server';

  const company = await getActiveCompany();

  try {
    await updateCompanySettings(company.id, {
      name: formData.get('name') as string,
      issuePrefix: formData.get('issuePrefix') as string,
      requiresBoardApprovalForHires: formData.get('requiresBoardApprovalForHires') === 'on',
      budgetMonthlyTokens: parseInt(formData.get('budgetMonthlyTokens') as string, 10),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save settings.';
    redirect(`/settings?error=${encodeURIComponent(message)}`);
  }

  redirect('/settings?saved=1');
}

async function saveIntegrations(formData: FormData) {
  'use server';

  const company = await getActiveCompany();

  try {
    await updateCompanyIntegrations(company.id, {
      searxngUrl: (formData.get('searxngUrl') as string) || undefined,
      searxngApiKey: (formData.get('searxngApiKey') as string) || undefined,
      bufferApiKey: (formData.get('bufferApiKey') as string) || undefined,
      clearBufferApiKey: formData.get('clearBufferApiKey') === 'on',
      clearSearxngApiKey: formData.get('clearSearxngApiKey') === 'on',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save integrations.';
    redirect(`/settings?error=${encodeURIComponent(message)}`);
  }

  redirect('/settings?saved=integrations');
}

function isConfigured(value: string | undefined, envFallback?: string): boolean {
  return Boolean(value?.trim() || envFallback?.trim());
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  const company = await getActiveCompany();
  const saved = resolvedSearchParams.saved;
  const error = resolvedSearchParams.error ? decodeURIComponent(resolvedSearchParams.error) : null;
  const integrationSettings = parseCompanySettings(company.settings);

  const llm = resolveModelProviderConfig();

  const envSettings = [
    { label: 'LLM provider', value: llm.provider },
    { label: 'LLM API mode', value: llm.apiMode },
    { label: 'Model base URL', value: llm.baseURL },
    { label: 'Default model', value: llm.defaultModel },
    { label: 'Redis', value: process.env.REDIS_URL ?? '—' },
    { label: 'Internal API', value: process.env.INTERNAL_API_URL ?? '—' },
    {
      label: 'Company workspace',
      value: process.env.COMPANY_WORKSPACE_ROOT ?? './data/company-workspaces',
    },
  ];

  const bufferConfigured = isConfigured(
    integrationSettings.mcpCredentials?.['buffer-mcp'],
    process.env.BUFFER_API_KEY,
  );
  const searxngConfigured = isSearxngConfigured(integrationSettings);

  return (
    <div className="p-6 max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Company and runtime configuration</p>
      </div>

      {saved === '1' && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Settings saved.
        </div>
      )}

      {saved === 'integrations' && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Integration settings saved.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Company</h2>
        <form action={saveSettings} className="space-y-4 border rounded-lg p-4">
          <div className="space-y-1.5">
            <label htmlFor="name" className="text-sm font-medium">
              Company name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              defaultValue={company.name}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="issuePrefix" className="text-sm font-medium">
              Issue prefix
            </label>
            <input
              id="issuePrefix"
              name="issuePrefix"
              type="text"
              required
              defaultValue={company.issuePrefix}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono uppercase"
            />
            <p className="text-xs text-muted-foreground">
              Used for issue IDs, e.g. {company.issuePrefix}-42
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="budgetMonthlyTokens" className="text-sm font-medium">
              Monthly token budget
            </label>
            <input
              id="budgetMonthlyTokens"
              name="budgetMonthlyTokens"
              type="number"
              required
              min={1}
              defaultValue={company.budgetMonthlyTokens}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Spent this month: {company.spentMonthlyTokens.toLocaleString()} tokens
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="requiresBoardApprovalForHires"
              defaultChecked={company.requiresBoardApprovalForHires}
              className="rounded border-input"
            />
            Require board approval for agent hires
          </label>

          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Save company settings
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Per-company credentials for agent toolsets. Environment variables in <code className="text-xs">.env</code> are used as fallbacks.
        </p>
        <form action={saveIntegrations} className="space-y-4 border rounded-lg p-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="searxngUrl" className="text-sm font-medium">
                SearXNG base URL
              </label>
              <span
                className={`text-xs rounded px-2 py-0.5 ${searxngConfigured ? 'bg-green-100 text-green-800' : 'bg-muted text-muted-foreground'}`}
              >
                {searxngConfigured ? 'Configured' : 'Not configured'}
              </span>
            </div>
            <input
              id="searxngUrl"
              name="searxngUrl"
              type="url"
              defaultValue={integrationSettings.searxngUrl ?? ''}
              placeholder={process.env.SEARXNG_URL ?? 'http://localhost:8888'}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Instance root URL only (no <code>/mcp</code> suffix). Enables the web-search toolset.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="searxngApiKey" className="text-sm font-medium">
              SearXNG API key (optional)
            </label>
            <input
              id="searxngApiKey"
              name="searxngApiKey"
              type="password"
              placeholder={integrationSettings.searxngApiKey ? '••••••••' : 'Optional — SEARXNG_API_KEY env'}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            {integrationSettings.searxngApiKey && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" name="clearSearxngApiKey" className="rounded border-input" />
                Clear stored key
              </label>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="bufferApiKey" className="text-sm font-medium">
                Buffer API key
              </label>
              <span
                className={`text-xs rounded px-2 py-0.5 ${bufferConfigured ? 'bg-green-100 text-green-800' : 'bg-muted text-muted-foreground'}`}
              >
                {bufferConfigured ? 'Configured' : 'Not configured'}
              </span>
            </div>
            <input
              id="bufferApiKey"
              name="bufferApiKey"
              type="password"
              placeholder={integrationSettings.mcpCredentials?.['buffer-mcp'] ? '••••••••' : 'BUFFER_API_KEY env'}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            {integrationSettings.mcpCredentials?.['buffer-mcp'] && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" name="clearBufferApiKey" className="rounded border-input" />
                Clear stored key
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              Enables the Buffer toolset (drafts, queue, posts via MCP).
            </p>
          </div>

          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Save integrations
          </button>
        </form>
      </section>

      <LlmProvidersSettings />

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Runtime (env fallback)</h2>
        <p className="text-sm text-muted-foreground">
          Used when an agent has no provider assigned, or to seed the default registry entry.
          Read from <code className="text-xs">.env</code> at the repo root.
        </p>
        <dl className="border rounded-lg divide-y text-sm">
          {envSettings.map((item) => (
            <div key={item.label} className="flex justify-between gap-4 p-3">
              <dt className="text-muted-foreground shrink-0">{item.label}</dt>
              <dd className="font-mono text-xs text-right break-all">{item.value}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-4 p-3">
            <dt className="text-muted-foreground shrink-0">SearXNG URL</dt>
            <dd className="font-mono text-xs text-right break-all">
              {process.env.SEARXNG_URL ?? 'Not configured'}
            </dd>
          </div>
          <div className="flex justify-between gap-4 p-3">
            <dt className="text-muted-foreground shrink-0">Buffer API key</dt>
            <dd className="font-mono text-xs text-right break-all">
              {process.env.BUFFER_API_KEY ? 'Set in env' : 'Not configured'}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
