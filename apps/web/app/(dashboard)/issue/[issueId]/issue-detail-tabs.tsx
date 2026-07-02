'use client';

import { useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { stickyPageToolbarClass, pageContentClass } from '@/lib/sticky-toolbar';

export function IssueDetailTabs({
  identifier,
  title,
  overview,
  observability,
}: {
  identifier: string;
  title: string;
  overview: ReactNode;
  observability: ReactNode;
}) {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();

  function refresh() {
    startRefresh(() => {
      router.refresh();
    });
  }

  return (
    <Tabs defaultValue="overview" className="w-full">
      <div className={cn(stickyPageToolbarClass, 'mb-4')}>
        <Link
          href="/issue"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Back to issues
        </Link>

        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-sm text-muted-foreground">{identifier}</p>
            <h2 className="truncate text-lg font-semibold tracking-tight sm:text-xl">{title}</h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isRefreshing}
              onClick={refresh}
            >
              <RefreshCw className={`size-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="observability">Observability</TabsTrigger>
            </TabsList>
          </div>
        </div>
      </div>

      <TabsContent value="overview" className={cn(pageContentClass, 'space-y-6')}>
        {overview}
      </TabsContent>
      <TabsContent value="observability" className={pageContentClass}>
        {observability}
      </TabsContent>
    </Tabs>
  );
}
