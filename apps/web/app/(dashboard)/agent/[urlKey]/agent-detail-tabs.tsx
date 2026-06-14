'use client';

import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function AgentDetailTabs({
  overview,
  observability,
}: {
  overview: ReactNode;
  observability: ReactNode;
}) {
  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="observability">Observability</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="mt-6 space-y-6">
        {overview}
      </TabsContent>
      <TabsContent value="observability" className="mt-6">
        {observability}
      </TabsContent>
    </Tabs>
  );
}
