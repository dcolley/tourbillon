'use client';

import { useRouter } from 'next/navigation';
import { setStoredCompanyId } from '@/lib/company-storage';
import { syncActiveCompanyAction } from '@/app/(dashboard)/company/actions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function AgentDisambiguation({
  urlKey,
  matches,
}: {
  urlKey: string;
  matches: Array<{ agent: { id: string; companyId: string; name: string; title: string }; companyName: string }>;
}) {
  const router = useRouter();

  async function select(companyId: string) {
    setStoredCompanyId(companyId);
    await syncActiveCompanyAction(companyId);
    router.push(`/agent/${urlKey}?c=${companyId}`);
    router.refresh();
  }

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col justify-center gap-6 p-6">
      <div className="space-y-1 text-center">
        <h1 className="text-xl font-bold tracking-tight">Which company?</h1>
        <p className="text-sm text-muted-foreground">
          Multiple companies have an agent with ID <span className="font-mono">{urlKey}</span>.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Select a company</CardTitle>
        </CardHeader>
        <CardContent className="divide-y p-0">
          {matches.map(({ agent, companyName }) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => void select(agent.companyId)}
              className="flex w-full flex-col items-start gap-0.5 p-4 text-left text-sm transition-colors hover:bg-muted/50"
            >
              <span className="font-medium">{companyName}</span>
              <span className="text-muted-foreground">
                {agent.name} · {agent.title}
              </span>
            </button>
          ))}
        </CardContent>
      </Card>
      <Button type="button" variant="outline" onClick={() => router.push('/agent')}>
        Back to agents
      </Button>
    </div>
  );
}
