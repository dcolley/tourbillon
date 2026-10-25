'use client';

import { Suspense, type ReactNode } from 'react';
import { Logo } from '@/components/logo';
import { CompanySwitcher, type CompanyOption } from '@/components/company-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { ViewSwitcher } from '@/components/view-switcher';
import { AssistantSidebar } from './sidebar';

/**
 * UI-1: shell for the assistant view (`/assistant`). Top bar with the view switcher and
 * company switcher. UI-2b: the left column is the agent/thread sidebar (remounted when the
 * active company changes); pages render the main area.
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
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 min-[528px]:gap-3 min-[528px]:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Logo size={24} />
          <span className="truncate text-sm font-semibold tracking-tight">
            {activeCompanyName ?? 'Tourbillon'}
          </span>
        </div>
        <ViewSwitcher current="assistant" />
        <div className="flex-1" />
        {/* UI-4: same picker as the Control Pane sidebar header; it sets its own width. Shown at all
            widths; H1: icon-only below 528px so ThemeToggle stays on-screen. */}
        <div className="shrink-0" data-assistant-company-picker>
          <CompanySwitcher companies={companies} activeCompanyId={activeCompanyId} compactOnNarrow />
        </div>
        <ThemeToggle />
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {activeCompanyId && (
          <Suspense fallback={null}>
            <AssistantSidebar key={activeCompanyId} />
          </Suspense>
        )}
        {children}
      </div>
    </div>
  );
}

/** Main area when no thread is open (the sidebar lists agents and threads). */
export function AssistantEmptyState() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Assistant</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Chat with your agents here. Pick an agent or a thread from the list to start.
      </p>
    </main>
  );
}
