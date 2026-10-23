'use client';

import type { ReactNode } from 'react';
import { Logo } from '@/components/logo';
import { CompanySwitcher, type CompanyOption } from '@/components/company-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { ViewSwitcher } from '@/components/view-switcher';

/**
 * UI-1: shell for the assistant view (`/assistant`). Top bar with the view switcher and
 * company switcher; the left column is a placeholder until UI-2 adds the agent/thread sidebar.
 */
export function AssistantShell({
  children,
  companies,
  activeCompanyId,
  activeCompanyName,
}: {
  children: ReactNode;
  companies: CompanyOption[];
  activeCompanyId: string | null;
  activeCompanyName: string | null;
}) {
  return (
    <div className="flex h-svh flex-col overflow-hidden" data-app-view="assistant">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Logo size={24} />
          <span className="truncate text-sm font-semibold tracking-tight">
            {activeCompanyName ?? 'Tourbillon'}
          </span>
        </div>
        <ViewSwitcher current="assistant" />
        <div className="flex-1" />
        <div className="hidden w-48 sm:block">
          <CompanySwitcher companies={companies} activeCompanyId={activeCompanyId} />
        </div>
        <ThemeToggle />
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

/** Placeholder agent list (UI-2 replaces it with the agent/thread sidebar). */
export function AssistantEmptyState() {
  return (
    <>
      <aside
        aria-label="Agents"
        className="hidden w-64 shrink-0 flex-col gap-2 border-r p-4 md:flex"
      >
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Agents
        </h2>
        <p className="text-sm text-muted-foreground">Your agents and their threads will appear here.</p>
      </aside>
      <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Assistant</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Chat with your agents here. Pick an agent from the list to start a thread.
        </p>
      </main>
    </>
  );
}
