import { CompanyGate } from '@/components/company-gate';
import { AssistantShell } from '@/components/assistant/assistant-shell';
import { TraceLinkProvider } from '@/components/assistant/trace-link';
import { phoenixUiBaseUrl } from '@tourbillon/shared';
import { getActiveCompanyOrNull, hasBoardSession, listCompanies } from '@/lib/company';

/**
 * UI-1: assistant view. Same gates as the Control Pane (app/(dashboard)/layout.tsx): the proxy
 * requires a board session for /assistant, this layout never lists companies without one
 * (#105 B1), and CompanyGate requires an active company before rendering the page.
 * OBS-1: the Phoenix UI base (server env, unset → no trace links) is provided to message footers.
 */
export default async function AssistantLayout({ children }: { children: React.ReactNode }) {
  const isBoard = await hasBoardSession();
  const [companies, activeCompany] = await Promise.all([
    isBoard ? listCompanies() : Promise.resolve([]),
    isBoard ? getActiveCompanyOrNull() : Promise.resolve(null),
  ]);

  return (
    <CompanyGate>
      <AssistantShell
        companies={companies.map((c) => ({
          id: c.id,
          name: c.name,
          issuePrefix: c.issuePrefix,
        }))}
        activeCompanyId={activeCompany?.id ?? null}
        activeCompanyName={activeCompany?.name ?? null}
      >
        <TraceLinkProvider baseUrl={phoenixUiBaseUrl() ?? null}>{activeCompany ? children : null}</TraceLinkProvider>
      </AssistantShell>
    </CompanyGate>
  );
}
