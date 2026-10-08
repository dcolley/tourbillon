import { Suspense } from 'react';
import { hasBoardSession, listCompanies } from '@/lib/company';
import { CompanySelector } from '@/components/company-selector';

function SelectorFallback() {
  return (
    <div className="flex min-h-svh items-center justify-center">
      <p className="text-sm text-muted-foreground">Loading companies…</p>
    </div>
  );
}

export default async function SelectCompanyPage() {
  // #105 B1: defence in depth behind proxy.ts; no session → empty list (and the proxy redirects).
  const companies = (await hasBoardSession()) ? await listCompanies() : [];

  return (
    <Suspense fallback={<SelectorFallback />}>
      <CompanySelector companies={companies} />
    </Suspense>
  );
}
