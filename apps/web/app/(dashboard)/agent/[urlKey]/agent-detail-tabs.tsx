'use client';

import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

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
  return (
    <Tabs defaultValue="overview" className="w-full">
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
