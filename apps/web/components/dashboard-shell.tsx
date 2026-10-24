'use client';

import type { CSSProperties, ReactNode } from 'react';
import { DashboardSidebar } from '@/components/dashboard-sidebar';
import { CONTROL_PANE_SIDEBAR_WIDTH, type CompanyOption } from '@/components/company-switcher';
import type { BuildInfo } from '@/lib/build-info';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { ChatContextProvider, ChatSidebarSlot } from '@/components/chat/chat-context';
import { SearchBoard } from '@/components/search-board';
import { ViewSwitcher } from '@/components/view-switcher';

export function DashboardShell({
  children,
  companies,
  activeCompanyId,
  activeCompanyName,
  buildInfo,
}: {
  children: ReactNode;
  companies: CompanyOption[];
  activeCompanyId: string | null;
  activeCompanyName: string | null;
  buildInfo: BuildInfo;
}) {
  return (
    <ChatContextProvider activeCompanyId={activeCompanyId}>
      <SidebarProvider
        className="h-svh overflow-hidden"
        style={
          {
            // UI-4: sized from the company picker so it fits the header exactly.
            '--sidebar-width': CONTROL_PANE_SIDEBAR_WIDTH,
            '--sidebar-width-icon': '2.75rem',
          } as CSSProperties
        }
      >
        <DashboardSidebar
          companies={companies}
          activeCompanyId={activeCompanyId}
          buildInfo={buildInfo}
        />
        <div className="flex min-w-0 flex-1 overflow-hidden" data-chat-resize-root>
          <SidebarInset className="min-w-0 flex-1">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <div className="md:hidden flex items-center gap-2">
                <SidebarTrigger />
                <Separator orientation="vertical" className="h-4" />
              </div>
              <span className="truncate text-sm font-semibold md:hidden">
                {activeCompanyName ?? 'Tourbillon'}
              </span>
              <ViewSwitcher current="control" />
              <div className="flex-1" />
              {activeCompanyId && <SearchBoard companyId={activeCompanyId} />}
            </header>
            <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4 pt-0 md:px-6 md:pb-6 [&>:not([data-sticky-toolbar-root])]:pt-4 md:[&>:not([data-sticky-toolbar-root])]:pt-6">
              {children}
            </div>
          </SidebarInset>
          <ChatSidebarSlot />
        </div>
      </SidebarProvider>
    </ChatContextProvider>
  );
}
