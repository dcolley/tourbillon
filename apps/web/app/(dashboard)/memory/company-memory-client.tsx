'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import {
  KnowledgeGraphPanel,
  type KgEntityView,
  type KgRelationView,
} from '@/app/(dashboard)/agent/[urlKey]/agent-memory-tab';

interface AgentOption {
  id: string;
  name: string;
  urlKey: string;
}

interface CompanyMemoryClientProps {
  agents: AgentOption[];
  selectedOverlay: string[];
  companyEntities: KgEntityView[];
  companyRelations: KgRelationView[];
  mergedEntities: KgEntityView[] | null;
  mergedRelations: KgRelationView[] | null;
  companyExists: boolean;
  mtimeMs: number | null;
}

export function CompanyMemoryClient({
  agents,
  selectedOverlay,
  companyEntities,
  companyRelations,
  mergedEntities,
  mergedRelations,
  companyExists,
  mtimeMs,
}: CompanyMemoryClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const selected = new Set(selectedOverlay);
  const showingMerged = selectedOverlay.length > 0 && mergedEntities !== null;

  function toggleOverlay(urlKey: string) {
    const next = new Set(selected);
    if (next.has(urlKey)) next.delete(urlKey);
    else next.add(urlKey);
    const overlay = [...next].join(',');
    startTransition(() => {
      router.push(overlay ? `/memory?overlay=${encodeURIComponent(overlay)}` : '/memory');
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-md border p-4 space-y-3">
        <div>
          <p className="text-sm font-medium">Overlay private agent graphs</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Optional human-only view. Private entities are prefixed with{' '}
            <span className="font-mono">urlKey:</span> so they do not collide with company names.
          </p>
        </div>
        {agents.length === 0 ? (
          <p className="text-xs text-muted-foreground">No agents in this company.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {agents.map((a) => {
              const on = selected.has(a.urlKey);
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => toggleOverlay(a.urlKey)}
                    className={`rounded-md border px-2.5 py-1 text-xs ${
                      on ? 'bg-muted font-medium' : 'hover:bg-muted/60'
                    }`}
                  >
                    {a.name}{' '}
                    <span className="font-mono text-muted-foreground">({a.urlKey})</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {pending && <p className="text-xs text-muted-foreground">Updating…</p>}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">
            {showingMerged ? 'Company + selected private overlays' : 'Company graph'}
          </h2>
          {mtimeMs != null && (
            <p className="text-[11px] text-muted-foreground">
              Updated {new Date(mtimeMs).toLocaleString()}
            </p>
          )}
        </div>
        <KnowledgeGraphPanel
          entities={showingMerged ? mergedEntities! : companyEntities}
          relations={showingMerged ? mergedRelations! : companyRelations}
          emptyMessage={
            companyExists
              ? 'Company memory file is empty.'
              : 'No company memory.jsonl yet — it is created when an agent with company mount writes to the graph.'
          }
        />
      </div>
    </div>
  );
}
