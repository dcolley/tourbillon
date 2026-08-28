'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type ViewTab = 'overview' | 'memory' | 'observability' | 'mail';

export function AgentDetailTabs({
  overview,
  memory,
  observability,
  mail,
}: {
  overview: ReactNode;
  memory: ReactNode;
  observability: ReactNode;
  mail: ReactNode;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const currentView = (searchParams.get('view') as ViewTab) || 'overview';

  const handleViewChange = (value: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('view', value);
    // Keep config param only if we're on overview
    if (value !== 'overview') {
      params.delete('config');
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  return (
    <Tabs value={currentView} onValueChange={handleViewChange} className="w-full">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="memory">Memory</TabsTrigger>
        <TabsTrigger value="observability">Observability</TabsTrigger>
        <TabsTrigger value="mail">Mail</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="mt-6 space-y-6">
        {overview}
      </TabsContent>
      <TabsContent value="memory" className="mt-6">
        {memory}
      </TabsContent>
      <TabsContent value="observability" className="mt-6">
        {observability}
      </TabsContent>
      <TabsContent value="mail" className="mt-6">
        {mail}
      </TabsContent>
    </Tabs>
  );
}
