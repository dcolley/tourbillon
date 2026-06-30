'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { setStoredCompanyId } from '@/lib/company-storage';
import { syncActiveCompanyAction } from '@/app/(dashboard)/company/actions';
import { CreateCompanyDialog } from '@/components/create-company-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';
import type { Company } from '@tourbillon/db';

export function CompanySelector({ companies }: { companies: Company[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo') || '/dashboard';
  const [createOpen, setCreateOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);

  useEffect(() => {
    if (companies.length !== 1 || selecting) return;

    const only = companies[0];
    setSelecting(true);
    setStoredCompanyId(only.id);
    void syncActiveCompanyAction(only.id).then(() => {
      router.push(returnTo);
    });
  }, [companies, returnTo, router, selecting]);

  async function selectCompany(companyId: string) {
    setSelecting(true);
    setStoredCompanyId(companyId);
    await syncActiveCompanyAction(companyId);
    router.push(returnTo);
  }

  async function handleCreated(companyId: string) {
    setSelecting(true);
    setStoredCompanyId(companyId);
    await syncActiveCompanyAction(companyId);
    setCreateOpen(false);
    router.push(returnTo);
  }

  if (companies.length === 1 && selecting) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <p className="text-sm text-muted-foreground">Opening {companies[0].name}…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-6 p-6">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Select a company</h1>
        <p className="text-sm text-muted-foreground">
          Choose which workspace to open. You can switch later from the sidebar.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your companies</CardTitle>
        </CardHeader>
        <CardContent className="divide-y p-0">
          {companies.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No companies yet. Create one below.</p>
          ) : (
            companies.map((company) => (
              <button
                key={company.id}
                type="button"
                disabled={selecting}
                onClick={() => void selectCompany(company.id)}
                className="flex w-full items-center justify-between gap-4 p-4 text-left text-sm transition-colors hover:bg-muted/50 disabled:opacity-50"
              >
                <div>
                  <p className="font-medium">{company.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{company.issuePrefix}</p>
                </div>
                <StatusBadge status={company.status} />
              </button>
            ))
          )}
        </CardContent>
      </Card>

      <Button type="button" onClick={() => setCreateOpen(true)} disabled={selecting}>
        + Create company
      </Button>

      <CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
    </div>
  );
}
