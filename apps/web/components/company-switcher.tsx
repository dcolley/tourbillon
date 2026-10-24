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
 * bar). The picker owns its width and truncation so it looks the same wherever it sits.
 *
 * Width: the trigger is always `COMPANY_SWITCHER_WIDTH` (14rem = 224px). The Control Pane
 * sidebar is sized from the same value (`CONTROL_PANE_SIDEBAR_WIDTH`), so the trigger fits the
 * sidebar header exactly and cannot drift from the Assistant one.
 */
export const COMPANY_SWITCHER_WIDTH = '14rem';

/**
 * Horizontal space the Control Pane sidebar uses around the picker: SidebarHeader `p-2`
 * (0.5rem each side) plus the sidebar container's 1px `border-r`.
 */
export const SIDEBAR_HEADER_INSET = '1rem + 1px';

/** `--sidebar-width` for the Control Pane: picker width plus the header inset. */
export const CONTROL_PANE_SIDEBAR_WIDTH = `calc(${COMPANY_SWITCHER_WIDTH} + ${SIDEBAR_HEADER_INSET})`;

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
    <div className="py-1 group-data-[collapsible=icon]:hidden" data-company-switcher>
      <Select
        value={activeCompanyId ?? undefined}
        onValueChange={handleValueChange}
        disabled={disabled}
      >
        <SelectTrigger
          aria-label="Company"
          title={label}
          className="h-8 shrink-0 text-xs"
          style={{ width: COMPANY_SWITCHER_WIDTH }}
          data-company-switcher-trigger
        >
          <span dir="auto" className="min-w-0 flex-1 truncate text-start font-medium" title={label}>
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
              <span dir="auto" className="min-w-0 flex-1 truncate text-start font-medium" title={company.name}>
                {company.name}
              </span>
              <span
                className="ml-auto shrink-0 text-right font-mono text-xs text-muted-foreground"
                data-company-switcher-prefix
              >
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

export interface CompanySwitchDeps {
  setStoredCompanyId: (companyId: string) => void;
  syncActiveCompany: (companyId: string) => Promise<unknown>;
  refresh: () => void;
  setSwitching: (switching: boolean) => void;
}

/**
 * Switch the active company. Returns false when nothing to do (same company or a switch is
 * already running). The picker is always re-enabled, even when the sync fails.
 */
export async function switchActiveCompany(
  companyId: string,
  state: { activeCompanyId: string | null; switching: boolean },
  deps: CompanySwitchDeps,
): Promise<boolean> {
  if (companyId === state.activeCompanyId || state.switching) return false;
  deps.setSwitching(true);
  try {
    deps.setStoredCompanyId(companyId);
    await deps.syncActiveCompany(companyId);
    deps.refresh();
  } finally {
    deps.setSwitching(false);
  }
  return true;
}

/** The view callbacks CompanySwitcher passes to CompanySwitcherView. */
export function companySwitcherHandlers(
  state: { activeCompanyId: string | null; switching: boolean },
  deps: CompanySwitchDeps & { openCreate: () => void; onError?: (error: unknown) => void },
): { onSelect: (companyId: string) => void; onCreate: () => void } {
  const onError = deps.onError ?? ((error: unknown) => console.error('Company switch failed', error));
  return {
    onSelect: (companyId) => {
      void switchActiveCompany(companyId, state, deps).catch(onError);
    },
    onCreate: () => deps.openCreate(),
  };
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

  const handlers = companySwitcherHandlers(
    { activeCompanyId, switching },
    {
      setStoredCompanyId,
      syncActiveCompany: syncActiveCompanyAction,
      refresh: () => router.refresh(),
      setSwitching,
      openCreate: () => setCreateOpen(true),
    },
  );

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
        onSelect={handlers.onSelect}
        onCreate={handlers.onCreate}
      />
      <CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
    </>
  );
}
