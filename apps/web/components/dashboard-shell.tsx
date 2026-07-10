'use client';

import type { CSSProperties, ReactNode } from 'react';
import { DashboardSidebar } from '@/components/dashboard-sidebar';
import type { CompanyOption } from '@/components/company-switcher';
import type { BuildInfo } from '@/lib/build-info';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';

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
    <SidebarProvider
      className="h-svh overflow-hidden"
      style={
        {
          '--sidebar-width': '10rem',
          '--sidebar-width-icon': '2.75rem',
        } as CSSProperties
      }
    >
      <DashboardSidebar
        companies={companies}
        activeCompanyId={activeCompanyId}
        buildInfo={buildInfo}
      />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <span className="truncate text-sm font-semibold">
            {activeCompanyName ?? 'Tourbillon'}
          </span>
        </header>
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4 pt-0 md:px-6 md:pb-6 [&>:not([data-sticky-toolbar-root])]:pt-4 md:[&>:not([data-sticky-toolbar-root])]:pt-6">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
