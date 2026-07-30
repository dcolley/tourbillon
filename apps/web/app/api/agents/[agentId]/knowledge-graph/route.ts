import { NextRequest, NextResponse } from 'next/server';
import { db, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import {
  loadAgentKnowledgeGraph,
  loadCompanyKnowledgeGraph,
  mergeKnowledgeGraphs,
  searchKnowledgeGraph,
  type KnowledgeGraphScope,
} from '@tourbillon/shared/knowledge-graph';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await context.params;

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  const scopeParam = (req.nextUrl.searchParams.get('scope') ?? 'private').toLowerCase();
  const query = req.nextUrl.searchParams.get('q') ?? '';

  if (scopeParam !== 'private' && scopeParam !== 'company' && scopeParam !== 'both') {
    return NextResponse.json(
      { error: 'Invalid scope. Use private, company, or both.' },
      { status: 400 },
    );
  }

  try {
    if (scopeParam === 'both') {
      const [privateGraph, companyGraph] = await Promise.all([
        loadAgentKnowledgeGraph(agent.companyId, agent.urlKey),
        loadCompanyKnowledgeGraph(agent.companyId),
      ]);

      const merged = mergeKnowledgeGraphs([
        { scope: 'private', graph: searchKnowledgeGraph(privateGraph, query) },
        { scope: 'company', graph: searchKnowledgeGraph(companyGraph, query) },
      ]);

      return NextResponse.json({
        scope: 'both' as const,
        entities: merged.entities,
        relations: merged.relations,
        sources: {
          private: {
            path: privateGraph.path,
            exists: privateGraph.exists,
            mtimeMs: privateGraph.mtimeMs,
            entityCount: privateGraph.entities.length,
            relationCount: privateGraph.relations.length,
          },
          company: {
            path: companyGraph.path,
            exists: companyGraph.exists,
            mtimeMs: companyGraph.mtimeMs,
            entityCount: companyGraph.entities.length,
            relationCount: companyGraph.relations.length,
          },
        },
      });
    }

    const scope = scopeParam as KnowledgeGraphScope;
    const graph =
      scope === 'private'
        ? await loadAgentKnowledgeGraph(agent.companyId, agent.urlKey)
        : await loadCompanyKnowledgeGraph(agent.companyId);

    const filtered = searchKnowledgeGraph(graph, query);

    return NextResponse.json({
      scope,
      path: graph.path,
      exists: graph.exists,
      mtimeMs: graph.mtimeMs,
      entities: filtered.entities,
      relations: filtered.relations,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load knowledge graph';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
