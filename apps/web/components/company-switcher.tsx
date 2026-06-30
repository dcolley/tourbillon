'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { setStoredCompanyId } from '@/lib/company-storage';
import { syncActiveCompanyAction } from '@/app/(dashboard)/company/actions';
import { CreateCompanyDialog } from '@/components/create-company-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';

export interface CompanyOption {
  id: string;
  name: string;
  issuePrefix: string;
}

export function CompanySwitcher({
  companies,
  activeCompanyId,
}: {
  companies: CompanyOption[];
  activeCompanyId: string | null;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  async function handleChange(companyId: string | null) {
    if (!companyId || companyId === activeCompanyId || switching) return;
    setSwitching(true);
    setStoredCompanyId(companyId);
    await syncActiveCompanyAction(companyId);
    router.refresh();
    setSwitching(false);
  }

  async function handleCreated(companyId: string) {
    setStoredCompanyId(companyId);
    await syncActiveCompanyAction(companyId);
    setCreateOpen(false);
    router.refresh();
  }

  if (companies.length === 0) {
    return (
      <>
        <Button type="button" size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
          Create company
        </Button>
        <CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
      </>
    );
  }

  const activeCompany = companies.find((c) => c.id === activeCompanyId);

  return (
    <>
      <div className="space-y-2 px-2 py-1 group-data-[collapsible=icon]:px-0">
        <Select
          value={activeCompanyId ?? undefined}
          onValueChange={(value) => void handleChange(value)}
          disabled={switching}
        >
          <SelectTrigger className="h-8 w-full text-xs group-data-[collapsible=icon]:hidden">
            <span className="truncate font-medium">
              {activeCompany?.name ?? 'Select company'}
            </span>
          </SelectTrigger>
          <SelectContent>
            {companies.map((company) => (
              <SelectItem key={company.id} value={company.id} label={company.name}>
                <span className="font-medium">{company.name}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {company.issuePrefix}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-start gap-1 px-2 text-xs group-data-[collapsible=icon]:hidden"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="size-3.5" />
          New company
        </Button>
      </div>
      <CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
    </>
  );
}
