import { redirect } from 'next/navigation';
import { getOrCreateDefaultCompany, updateCompanySettings } from '@/lib/company';
import { resolveModelProviderConfig } from '@tourbillon/shared';

async function saveSettings(formData: FormData) {
  'use server';

  const company = await getOrCreateDefaultCompany();

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

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  const company = await getOrCreateDefaultCompany();
  const saved = resolvedSearchParams.saved === '1';
  const error = resolvedSearchParams.error ? decodeURIComponent(resolvedSearchParams.error) : null;

  const llm = resolveModelProviderConfig();

  const envSettings = [
    { label: 'LLM provider', value: llm.provider },
    { label: 'LLM API mode', value: llm.apiMode },
    { label: 'Model base URL', value: llm.baseURL },
    { label: 'Default model', value: llm.defaultModel },
    { label: 'Redis', value: process.env.REDIS_URL ?? '—' },
    { label: 'Internal API', value: process.env.INTERNAL_API_URL ?? '—' },
    { label: 'SearXNG', value: process.env.SEARXNG_URL ?? 'Not configured' },
    {
      label: 'Company workspace',
      value: process.env.COMPANY_WORKSPACE_ROOT ?? './data/company-workspaces',
    },
  ];

  return (
    <div className="p-6 max-w-lg space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Company and runtime configuration</p>
      </div>

      {saved && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Settings saved.
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
        <h2 className="text-lg font-semibold">Runtime</h2>
        <p className="text-sm text-muted-foreground">
          Read from <code className="text-xs">.env</code> at the repo root. Restart the dev server after changes.
        </p>
        <dl className="border rounded-lg divide-y text-sm">
          {envSettings.map((item) => (
            <div key={item.label} className="flex justify-between gap-4 p-3">
              <dt className="text-muted-foreground shrink-0">{item.label}</dt>
              <dd className="font-mono text-xs text-right break-all">{item.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
