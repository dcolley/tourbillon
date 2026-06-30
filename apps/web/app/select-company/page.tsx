import { Suspense } from 'react';
import { listCompanies } from '@/lib/company';
import { CompanySelector } from '@/components/company-selector';

function SelectorFallback() {
  return (
    <div className="flex min-h-svh items-center justify-center">
      <p className="text-sm text-muted-foreground">Loading companies…</p>
    </div>
  );
}

export default async function SelectCompanyPage() {
  const companies = await listCompanies();

  return (
    <Suspense fallback={<SelectorFallback />}>
      <CompanySelector companies={companies} />
    </Suspense>
  );
}
