import { CompanyGate } from '@/components/company-gate';
import { DashboardShell } from '@/components/dashboard-shell';
import { getActiveCompanyOrNull, hasBoardSession, listCompanies } from '@/lib/company';
import { getBuildInfo } from '@/lib/build-info';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // #105 B1: never list companies without a board session. The proxy normally guarantees one,
  // but this layout must not leak every company if a path ever slips past the matcher.
  const isBoard = await hasBoardSession();
  const [companies, activeCompany] = await Promise.all([
    isBoard ? listCompanies() : Promise.resolve([]),
    isBoard ? getActiveCompanyOrNull() : Promise.resolve(null),
  ]);
  const buildInfo = getBuildInfo();

  return (
    <CompanyGate>
      <DashboardShell
        companies={companies.map((c) => ({
          id: c.id,
          name: c.name,
          issuePrefix: c.issuePrefix,
        }))}
        activeCompanyId={activeCompany?.id ?? null}
        activeCompanyName={activeCompany?.name ?? null}
        buildInfo={buildInfo}
      >
        {activeCompany ? children : null}
      </DashboardShell>
    </CompanyGate>
  );
}
