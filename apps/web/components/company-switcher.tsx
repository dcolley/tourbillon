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
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';

export interface CompanyOption {
  id: string;
  name: string;
  issuePrefix: string;
}

/**
 * UI-4: one company picker for both views (Control Pane sidebar header and the Assistant top
 * bar). The picker owns its own padding and truncation so it looks the same wherever it sits.
 *
 * Width: in the Control Pane the picker fills the sidebar header (sidebar 16rem minus the
 * header's 0.5rem padding on each side = 15rem). Containers outside the sidebar wrap it in
 * `COMPANY_SWITCHER_WIDTH_CLASS` so the trigger ends up the same width there too.
 */
export const COMPANY_SWITCHER_WIDTH_CLASS = 'w-60';

/** Select value for the "New company" entry; never a real company id (ids are UUIDs). */
export const NEW_COMPANY_VALUE = '__new_company__';

export type CompanySwitcherAction =
  | { type: 'create' }
  | { type: 'select'; companyId: string }
  | null;

/** What picking `value` in the dropdown should do. */
export function companySwitcherAction(
  value: string | null | undefined,
  activeCompanyId: string | null,
): CompanySwitcherAction {
  if (!value) return null;
  if (value === NEW_COMPANY_VALUE) return { type: 'create' };
  if (value === activeCompanyId) return null;
  return { type: 'select', companyId: value };
}

/** Stateless picker: trigger plus dropdown (companies, divider, "New company" last). */
export function CompanySwitcherView({
  companies,
  activeCompanyId,
  disabled = false,
  onSelect,
  onCreate,
}: {
  companies: CompanyOption[];
  activeCompanyId: string | null;
  disabled?: boolean;
  onSelect: (companyId: string) => void;
  onCreate: () => void;
}) {
  const activeCompany = companies.find((c) => c.id === activeCompanyId);
  const label = activeCompany?.name ?? 'Select company';

  function handleValueChange(value: unknown) {
    const action = companySwitcherAction(typeof value === 'string' ? value : null, activeCompanyId);
    if (action?.type === 'create') onCreate();
    else if (action?.type === 'select') onSelect(action.companyId);
  }

  return (
    <div
      className="min-w-0 px-2 py-1 group-data-[collapsible=icon]:px-0"
      data-company-switcher
    >
      <Select
        value={activeCompanyId ?? undefined}
        onValueChange={handleValueChange}
        disabled={disabled}
      >
        <SelectTrigger
          aria-label="Company"
          title={label}
          className="h-8 w-full min-w-0 text-xs group-data-[collapsible=icon]:hidden"
        >
          <span className="min-w-0 flex-1 truncate text-left font-medium" title={label}>
            {label}
          </span>
        </SelectTrigger>
        <SelectContent>
          {companies.map((company) => (
            <SelectItem
              key={company.id}
              value={company.id}
              label={company.name}
              title={company.name}
              className="[&>*:first-child]:min-w-0 [&>*:first-child]:shrink"
            >
              <span className="min-w-0 truncate font-medium" title={company.name}>
                {company.name}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {company.issuePrefix}
              </span>
            </SelectItem>
          ))}
          <SelectSeparator data-company-switcher-divider />
          <SelectItem
            value={NEW_COMPANY_VALUE}
            label="New company"
            data-company-switcher-new
          >
            <Plus className="size-3.5" />
            <span>New company</span>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
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

  async function handleChange(companyId: string) {
    if (companyId === activeCompanyId || switching) return;
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

  return (
    <>
      <CompanySwitcherView
        companies={companies}
        activeCompanyId={activeCompanyId}
        disabled={switching}
        onSelect={(companyId) => void handleChange(companyId)}
        onCreate={() => setCreateOpen(true)}
      />
      <CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
    </>
  );
}
