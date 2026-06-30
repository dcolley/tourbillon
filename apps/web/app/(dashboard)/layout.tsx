import { CompanyGate } from '@/components/company-gate';
import { DashboardShell } from '@/components/dashboard-shell';
import { getActiveCompanyOrNull, listCompanies } from '@/lib/company';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [companies, activeCompany] = await Promise.all([listCompanies(), getActiveCompanyOrNull()]);

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
      >
        {children}
      </DashboardShell>
    </CompanyGate>
  );
}
