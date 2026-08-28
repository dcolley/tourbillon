'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ReactNode } from 'react';

type ConfigTab = 'profile' | 'model' | 'runtime' | 'heartbeats' | 'capabilities' | 'budget' | 'routines' | 'danger';

export function AgentOverviewConfigTabs({
  profile,
  model,
  runtime,
  heartbeats,
  capabilities,
  budget,
  routines,
  danger,
  recentHeartbeats,
  clone,
}: {
  profile: ReactNode;
  model: ReactNode;
  runtime: ReactNode;
  heartbeats: ReactNode;
  capabilities: ReactNode;
  budget: ReactNode;
  routines: ReactNode | null;
  danger: ReactNode;
  recentHeartbeats: ReactNode;
  clone: ReactNode;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const currentConfig = (searchParams.get('config') as ConfigTab) || 'profile';
  const currentView = searchParams.get('view') || 'overview';

  const handleConfigChange = (value: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('config', value);
    params.set('view', currentView);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-6">
      <Tabs value={currentConfig} onValueChange={handleConfigChange} className="w-full">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="model">Model</TabsTrigger>
          <TabsTrigger value="runtime">Runtime</TabsTrigger>
          <TabsTrigger value="heartbeats">Heartbeats</TabsTrigger>
          <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
          <TabsTrigger value="budget">Budget</TabsTrigger>
          {routines && <TabsTrigger value="routines">Routines</TabsTrigger>}
          <TabsTrigger value="danger">Danger</TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="mt-6 space-y-6">
          {profile}
        </TabsContent>
        <TabsContent value="model" className="mt-6 space-y-6">
          {model}
        </TabsContent>
        <TabsContent value="runtime" className="mt-6 space-y-6">
          {runtime}
        </TabsContent>
        <TabsContent value="heartbeats" className="mt-6 space-y-6">
          {heartbeats}
          {recentHeartbeats}
        </TabsContent>
        <TabsContent value="capabilities" className="mt-6 space-y-6">
          {capabilities}
        </TabsContent>
        <TabsContent value="budget" className="mt-6 space-y-6">
          {budget}
        </TabsContent>
        {routines && (
          <TabsContent value="routines" className="mt-6 space-y-6">
            {routines}
          </TabsContent>
        )}
        <TabsContent value="danger" className="mt-6 space-y-6">
          {clone}
          {danger}
        </TabsContent>
      </Tabs>
    </div>
  );
}
