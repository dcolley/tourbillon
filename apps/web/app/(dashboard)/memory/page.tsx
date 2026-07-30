import Link from 'next/link';
import { getActiveCompanyOrNull } from '@/lib/company';
import { db, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import {
  loadCompanyKnowledgeGraph,
  loadAgentKnowledgeGraph,
  mergeKnowledgeGraphs,
} from '@tourbillon/shared/knowledge-graph';
import { getCompanyMemoryFilePath } from '@tourbillon/shared/company-workspace';
import { CompanyMemoryClient } from './company-memory-client';

export default async function CompanyMemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ overlay?: string }>;
}) {
  const { overlay } = await searchParams;
  const company = await getActiveCompanyOrNull();
  if (!company) return null;

  const companyAgents = await db
    .select({ id: agents.id, name: agents.name, urlKey: agents.urlKey })
    .from(agents)
    .where(eq(agents.companyId, company.id))
    .orderBy(agents.name);

  const overlayKeys = (overlay ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const overlaySet = new Set(overlayKeys);

  const companyGraph = await loadCompanyKnowledgeGraph(company.id);

  const overlayGraphs = await Promise.all(
    companyAgents
      .filter((a) => overlaySet.has(a.urlKey))
      .map(async (a) => {
        const g = await loadAgentKnowledgeGraph(company.id, a.urlKey);
        return { urlKey: a.urlKey, name: a.name, graph: g };
      }),
  );

  const merged =
    overlayGraphs.length > 0
      ? mergeKnowledgeGraphs([
          { scope: 'company', graph: companyGraph },
          ...overlayGraphs.map((o) => ({
            scope: 'private' as const,
            graph: {
              entities: o.graph.entities.map((e) => ({
                ...e,
                name: `${o.urlKey}:${e.name}`,
              })),
              relations: o.graph.relations.map((r) => ({
                ...r,
                from: `${o.urlKey}:${r.from}`,
                to: `${o.urlKey}:${r.to}`,
              })),
            },
          })),
        ])
      : null;

  return (
    <div className="max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Company memory</h1>
        <p className="text-muted-foreground mt-1">
          Shared knowledge-graph JSONL at the company workspace root. Agents mount this file when company memory is
          enabled under Capabilities.
        </p>
        <p className="text-[11px] font-mono text-muted-foreground mt-2 break-all">
          {getCompanyMemoryFilePath(company.id)}
          {!companyGraph.exists ? ' (not created yet)' : ''}
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          Also browse raw files in the{' '}
          <Link href="/workspace?path=memory.jsonl" className="underline underline-offset-2">
            Workspace
          </Link>
          .
        </p>
      </div>

      <CompanyMemoryClient
        agents={companyAgents}
        selectedOverlay={overlayKeys}
        companyEntities={companyGraph.entities}
        companyRelations={companyGraph.relations}
        mergedEntities={merged?.entities ?? null}
        mergedRelations={merged?.relations ?? null}
        companyExists={companyGraph.exists}
        mtimeMs={companyGraph.mtimeMs}
      />
    </div>
  );
}
