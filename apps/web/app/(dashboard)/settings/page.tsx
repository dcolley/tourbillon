import {
  getActiveCompany,
  getActiveCompanyOrNull,
  updateCompanySettings,
  updateCompanyIntegrations,
  updateCompanyObservationalMemory,
  updateCompanyHitlyGate,
} from '@/lib/company';
import {
  getExecutionWorkspaceRoot,
  getWorkspaceRoot,
  resolveModelProviderConfig,
  parseCompanySettings,
  isSearxngConfigured,
  isTavilyConfigured,
  isHitlyGateConfigured,
  resolveObservationalMemoryModel,
} from '@tourbillon/shared';
import { LlmProvidersSettings } from '@/components/llm-providers-settings';
import { ObservationalMemorySettingsForm } from '@/components/observational-memory-settings-form';
import { listLlmProvidersPublic } from '@/lib/llm-providers';
import { actionError, actionSuccess, type ActionResult } from '@/lib/action-result';
import { CompanySettingsTabs } from './company-settings-tabs';

async function saveSettings(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const company = await getActiveCompany();

  try {
    await updateCompanySettings(company.id, {
      name: formData.get('name') as string,
      issuePrefix: formData.get('issuePrefix') as string,
      requiresBoardApprovalForHires: formData.get('requiresBoardApprovalForHires') === 'on',
      budgetMonthlyTokens: parseInt(formData.get('budgetMonthlyTokens') as string, 10),
    });
    return actionSuccess('Company settings saved.');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save settings.';
    return actionError(message);
  }
}

async function saveIntegrations(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const company = await getActiveCompany();

  try {
    await updateCompanyIntegrations(company.id, {
      searxngUrl: (formData.get('searxngUrl') as string) || undefined,
      searxngApiKey: (formData.get('searxngApiKey') as string) || undefined,
      tavilyApiKey: (formData.get('tavilyApiKey') as string) || undefined,
      bufferApiKey: (formData.get('bufferApiKey') as string) || undefined,
      clearBufferApiKey: formData.get('clearBufferApiKey') === 'on',
      clearSearxngApiKey: formData.get('clearSearxngApiKey') === 'on',
      clearTavilyApiKey: formData.get('clearTavilyApiKey') === 'on',
    });
    return actionSuccess('Integration settings saved.');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save integrations.';
    return actionError(message);
  }
}

async function saveObservationalMemory(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  try {
    const company = await getActiveCompany();
    
    // Parse numeric fields
    let maxOutputTokens: number | undefined;
    let observeAfterTokens: number | undefined;
    let reflectAfterTokens: number | undefined;
    let temperature: number | undefined;

    const maxOutputRaw = formData.get('maxOutputTokens');
    if (maxOutputRaw && String(maxOutputRaw).trim()) {
      maxOutputTokens = parseInt(String(maxOutputRaw), 10);
      if (!Number.isFinite(maxOutputTokens)) {
        return actionError('Max output tokens must be a valid number.');
      }
    }

    const observeAfterRaw = formData.get('observeAfterTokens');
    if (observeAfterRaw && String(observeAfterRaw).trim()) {
      observeAfterTokens = parseInt(String(observeAfterRaw), 10);
      if (!Number.isFinite(observeAfterTokens)) {
        return actionError('Observe after tokens must be a valid number.');
      }
    }

    const reflectAfterRaw = formData.get('reflectAfterTokens');
    if (reflectAfterRaw && String(reflectAfterRaw).trim()) {
      reflectAfterTokens = parseInt(String(reflectAfterRaw), 10);
      if (!Number.isFinite(reflectAfterTokens)) {
        return actionError('Reflect after tokens must be a valid number.');
      }
    }

    const temperatureRaw = formData.get('temperature');
    if (temperatureRaw && String(temperatureRaw).trim()) {
      temperature = parseFloat(String(temperatureRaw));
      if (!Number.isFinite(temperature)) {
        return actionError('Temperature must be a valid number.');
      }
    }

    await updateCompanyObservationalMemory(company.id, {
      enabled: formData.get('enabled') === 'on',
      providerId: (formData.get('providerId') as string) || undefined,
      modelId: (formData.get('modelId') as string) || undefined,
      maxOutputTokens,
      observeAfterTokens,
      reflectAfterTokens,
      temperature,
    });
    return actionSuccess('Observational Memory settings saved.');
  } catch (err) {
    return actionError(err instanceof Error ? err.message : 'Failed to save Observational Memory.');
  }
}

async function saveHitlyGate(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const company = await getActiveCompany();

  try {
    await updateCompanyHitlyGate(company.id, {
      enabled: formData.get('enabled') === 'on',
      baseUrl: (formData.get('baseUrl') as string) || undefined,
      resumeHost: (formData.get('resumeHost') as string) || undefined,
      projectId: (formData.get('projectId') as string) || undefined,
      apiKey: (formData.get('apiKey') as string) || undefined,
      clearApiKey: formData.get('clearApiKey') === 'on',
    });
    return actionSuccess('HITLy gate settings saved.');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save HITLy gate settings.';
    return actionError(message);
  }
}

function isConfigured(value: string | undefined, envFallback?: string): boolean {
  return Boolean(value?.trim() || envFallback?.trim());
}

export default async function SettingsPage() {
  const company = await getActiveCompanyOrNull();
  if (!company) return null;
  const integrationSettings = parseCompanySettings(company.settings);
  const omResolved = resolveObservationalMemoryModel(integrationSettings);
  const providers = await listLlmProvidersPublic();

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
      value: getWorkspaceRoot(),
    },
    {
      label: 'Execution workspace',
      value: getExecutionWorkspaceRoot(),
    },
    {
      label: 'Sandbox isolation',
      value: process.env.SANDBOX_ISOLATION ?? 'platform default',
    },
    {
      label: 'Sandbox timeout',
      value: process.env.SANDBOX_COMMAND_TIMEOUT_MS
        ? `${process.env.SANDBOX_COMMAND_TIMEOUT_MS} ms`
        : '120000 ms (default)',
    },
  ];

  const bufferConfigured = isConfigured(
    integrationSettings.mcpCredentials?.['buffer-mcp'],
    process.env.BUFFER_API_KEY,
  );
  const searxngConfigured = isSearxngConfigured(integrationSettings);
  const tavilyConfigured = isTavilyConfigured(integrationSettings);
  const hitlyGateConfigured = isHitlyGateConfigured(integrationSettings);

  return (
    <div className="p-6 max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Company and runtime configuration</p>
      </div>

      <CompanySettingsTabs
        company={<CompanyTab company={company} saveSettings={saveSettings} />}
        integrations={
          <IntegrationsTab
            integrationSettings={integrationSettings}
            searxngConfigured={searxngConfigured}
            tavilyConfigured={tavilyConfigured}
            bufferConfigured={bufferConfigured}
            saveIntegrations={saveIntegrations}
          />
        }
        hitly={
          <HitlyTab
            integrationSettings={integrationSettings}
            hitlyGateConfigured={hitlyGateConfigured}
            saveHitlyGate={saveHitlyGate}
          />
        }
        om={
          <ObservationalMemoryTab
            integrationSettings={integrationSettings}
            omResolved={omResolved}
            providers={providers}
            saveObservationalMemory={saveObservationalMemory}
          />
        }
        runtime={<RuntimeTab envSettings={envSettings} />}
        providers={<ProvidersTab />}
      />
    </div>
  );
}

function CompanyTab({
  company,
  saveSettings,
}: {
  company: { id: string; name: string; issuePrefix: string; budgetMonthlyTokens: number; spentMonthlyTokens: number; requiresBoardApprovalForHires: boolean };
  saveSettings: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}) {
  const ActionForm = require('@/components/action-form').ActionForm;
  const ActionSubmitButton = require('@/components/action-form').ActionSubmitButton;

  return (
    <section className="border rounded-lg p-4">
      <ActionForm action={saveSettings} className="space-y-4">
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

        <ActionSubmitButton label="Save company settings" />
      </ActionForm>
    </section>
  );
}

function IntegrationsTab({
  integrationSettings,
  searxngConfigured,
  tavilyConfigured,
  bufferConfigured,
  saveIntegrations,
}: {
  integrationSettings: any;
  searxngConfigured: boolean;
  tavilyConfigured: boolean;
  bufferConfigured: boolean;
  saveIntegrations: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}) {
  const ActionForm = require('@/components/action-form').ActionForm;
  const ActionSubmitButton = require('@/components/action-form').ActionSubmitButton;

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Per-company credentials for agent toolsets. Environment variables in <code className="text-xs">.env</code> are used as fallbacks.
      </p>
      <ActionForm action={saveIntegrations} className="space-y-4 border rounded-lg p-4">
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
            <label htmlFor="tavilyApiKey" className="text-sm font-medium">
              Tavily API key
            </label>
            <span
              className={`text-xs rounded px-2 py-0.5 ${tavilyConfigured ? 'bg-green-100 text-green-800' : 'bg-muted text-muted-foreground'}`}
            >
              {tavilyConfigured ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <input
            id="tavilyApiKey"
            name="tavilyApiKey"
            type="password"
            placeholder={integrationSettings.tavilyApiKey ? '••••••••' : 'TAVILY_API_KEY env'}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          {integrationSettings.tavilyApiKey && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" name="clearTavilyApiKey" className="rounded border-input" />
              Clear stored key
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            Enables the web-search-tavily toolset (cloud web search via Tavily).
          </p>
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

        <ActionSubmitButton label="Save integrations" />
      </ActionForm>
    </section>
  );
}

function HitlyTab({
  integrationSettings,
  hitlyGateConfigured,
  saveHitlyGate,
}: {
  integrationSettings: any;
  hitlyGateConfigured: boolean;
  saveHitlyGate: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}) {
  const ActionForm = require('@/components/action-form').ActionForm;
  const ActionSubmitButton = require('@/components/action-form').ActionSubmitButton;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">HITLy Approval Gate</h2>
        <span
          className={`text-xs rounded px-2 py-0.5 ${hitlyGateConfigured ? 'bg-green-100 text-green-800' : 'bg-muted text-muted-foreground'}`}
        >
          {hitlyGateConfigured ? 'Enabled' : 'Off'}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        When enabled, new approvals from <code className="text-xs">createApproval</code> also open a HITLy work item.
        The approval stays pending until HITLy decides, then we apply the decision here.
        If disabled, approvals use the in-app Approvals page only.
      </p>
      <ActionForm action={saveHitlyGate} className="space-y-4 border rounded-lg p-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={integrationSettings.hitlyGate?.enabled === true}
            className="rounded border-input"
          />
          <span className="font-medium">Send approvals to HITLy</span>
        </label>

        <div className="space-y-2">
          <label htmlFor="hitlyBaseUrl" className="text-sm font-medium">
            HITLy base URL
          </label>
          <input
            id="hitlyBaseUrl"
            name="baseUrl"
            type="url"
            defaultValue={integrationSettings.hitlyGate?.baseUrl ?? ''}
            placeholder="http://localhost:3001"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Where Tourbillon POSTs ingest requests. Example: <code className="text-xs">http://localhost:3001</code>
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="hitlyResumeHost" className="text-sm font-medium">
            Tourbillon resume host
          </label>
          <input
            id="hitlyResumeHost"
            name="resumeHost"
            type="url"
            defaultValue={integrationSettings.hitlyGate?.resumeHost ?? ''}
            placeholder="https://tourbillon.example.com"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Reachable host HITLy can POST resume callbacks to (no trailing slash). Must be accessible from HITLy.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="hitlyProjectId" className="text-sm font-medium">
            HITLy project ID
          </label>
          <input
            id="hitlyProjectId"
            name="projectId"
            type="text"
            defaultValue={integrationSettings.hitlyGate?.projectId ?? ''}
            placeholder="prj_..."
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Project ID from HITLy (e.g. <code className="text-xs">prj_abc123</code>)
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="hitlyApiKey" className="text-sm font-medium">
            HITLy API key
          </label>
          <input
            id="hitlyApiKey"
            name="apiKey"
            type="password"
            placeholder={integrationSettings.hitlyGate?.apiKey ? '••••••••' : 'Project API key'}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          {integrationSettings.hitlyGate?.apiKey && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" name="clearApiKey" className="rounded border-input" />
              Clear stored key
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            HITLy project API key (used for ingest authorization)
          </p>
        </div>

        <ActionSubmitButton label="Save HITLy gate settings" />
      </ActionForm>
    </section>
  );
}

function ObservationalMemoryTab({
  integrationSettings,
  omResolved,
  providers,
  saveObservationalMemory,
}: {
  integrationSettings: any;
  omResolved: any;
  providers: any[];
  saveObservationalMemory: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Observational Memory</h2>
        <span
          className={`text-xs rounded px-2 py-0.5 ${omResolved ? 'bg-green-100 text-green-800' : 'bg-muted text-muted-foreground'}`}
        >
          {omResolved ? 'Enabled' : 'Off'}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Compacts long assignment and harness Session history before it hits the TokenLimiter
        ceiling. Applies to harness on-demand idle threads as well as issue threads. Uses the
        selected provider/model for Observer and Reflector (not the agent&apos;s chat model).
        Does not shrink system prompt or tool schemas.
      </p>
      <div className="border rounded-lg p-4">
        <ObservationalMemorySettingsForm
          initialEnabled={integrationSettings.observationalMemory?.enabled === true}
          initialProviderId={integrationSettings.observationalMemory?.providerId ?? null}
          initialModelId={integrationSettings.observationalMemory?.modelId ?? ''}
          initialMaxOutputTokens={integrationSettings.observationalMemory?.maxOutputTokens}
          initialObserveAfterTokens={integrationSettings.observationalMemory?.observeAfterTokens}
          initialReflectAfterTokens={integrationSettings.observationalMemory?.reflectAfterTokens}
          initialTemperature={integrationSettings.observationalMemory?.temperature}
          providers={providers}
          saveAction={saveObservationalMemory}
        />
      </div>
    </section>
  );
}

function RuntimeTab({ envSettings }: { envSettings: Array<{ label: string; value: string }> }) {
  return (
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
          <dt className="text-muted-foreground shrink-0">Tavily API key</dt>
          <dd className="font-mono text-xs text-right break-all">
            {process.env.TAVILY_API_KEY ? 'Set in env' : 'Not configured'}
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
  );
}

function ProvidersTab() {
  return (
    <section className="space-y-4">
      <LlmProvidersSettings />
    </section>
  );
}
