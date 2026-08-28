'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ReactNode } from 'react';

type TabId = 'company' | 'integrations' | 'hitly' | 'om' | 'runtime' | 'providers';

export function CompanySettingsTabs({
  company,
  integrations,
  hitly,
  om,
  runtime,
  providers,
}: {
  company: ReactNode;
  integrations: ReactNode;
  hitly: ReactNode;
  om: ReactNode;
  runtime: ReactNode;
  providers: ReactNode;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const currentTab = (searchParams.get('tab') as TabId) || 'company';

  const handleTabChange = (value: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', value);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  return (
    <Tabs value={currentTab} onValueChange={handleTabChange} className="w-full">
      <TabsList>
        <TabsTrigger value="company">Company</TabsTrigger>
        <TabsTrigger value="integrations">Integrations</TabsTrigger>
        <TabsTrigger value="hitly">HITLy</TabsTrigger>
        <TabsTrigger value="om">Observational Memory</TabsTrigger>
        <TabsTrigger value="runtime">Runtime</TabsTrigger>
        <TabsTrigger value="providers">Providers</TabsTrigger>
      </TabsList>
      <TabsContent value="company" className="mt-6 space-y-4">
        {company}
      </TabsContent>
      <TabsContent value="integrations" className="mt-6 space-y-4">
        {integrations}
      </TabsContent>
      <TabsContent value="hitly" className="mt-6 space-y-4">
        {hitly}
      </TabsContent>
      <TabsContent value="om" className="mt-6 space-y-4">
        {om}
      </TabsContent>
      <TabsContent value="runtime" className="mt-6 space-y-4">
        {runtime}
      </TabsContent>
      <TabsContent value="providers" className="mt-6 space-y-4">
        {providers}
      </TabsContent>
    </Tabs>
  );
}
