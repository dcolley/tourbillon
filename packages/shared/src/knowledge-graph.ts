import { readFile, stat } from 'fs/promises';
import {
  getAgentMemoryFilePath,
  getCompanyMemoryFilePath,
} from './company-workspace';

export interface KgEntity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface KgRelation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: KgEntity[];
  relations: KgRelation[];
}

export type KnowledgeGraphScope = 'private' | 'company';

export interface ScopedKnowledgeGraph extends KnowledgeGraph {
  scope: KnowledgeGraphScope;
  path: string;
  mtimeMs: number | null;
  exists: boolean;
}

export interface AttributedKgEntity extends KgEntity {
  sources: KnowledgeGraphScope[];
}

export interface AttributedKgRelation extends KgRelation {
  sources: KnowledgeGraphScope[];
}

export interface MergedKnowledgeGraph {
  entities: AttributedKgEntity[];
  relations: AttributedKgRelation[];
}

export function emptyKnowledgeGraph(): KnowledgeGraph {
  return { entities: [], relations: [] };
}

export async function parseKnowledgeGraphJsonl(filePath: string): Promise<{
  graph: KnowledgeGraph;
  mtimeMs: number | null;
  exists: boolean;
}> {
  try {
    const [raw, fileStat] = await Promise.all([
      readFile(filePath, 'utf-8'),
      stat(filePath),
    ]);
    const graph = emptyKnowledgeGraph();
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let item: unknown;
      try {
        item = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (row.type === 'entity' && typeof row.name === 'string') {
        graph.entities.push({
          name: row.name,
          entityType: typeof row.entityType === 'string' ? row.entityType : 'unknown',
          observations: Array.isArray(row.observations)
            ? row.observations.filter((o): o is string => typeof o === 'string')
            : [],
        });
      } else if (
        row.type === 'relation' &&
        typeof row.from === 'string' &&
        typeof row.to === 'string'
      ) {
        graph.relations.push({
          from: row.from,
          to: row.to,
          relationType: typeof row.relationType === 'string' ? row.relationType : 'related_to',
        });
      }
    }
    return { graph, mtimeMs: fileStat.mtimeMs, exists: true };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return { graph: emptyKnowledgeGraph(), mtimeMs: null, exists: false };
    }
    throw err;
  }
}

export async function loadAgentKnowledgeGraph(
  companyId: string,
  urlKey: string,
): Promise<ScopedKnowledgeGraph> {
  const path = getAgentMemoryFilePath(companyId, urlKey);
  const { graph, mtimeMs, exists } = await parseKnowledgeGraphJsonl(path);
  return { ...graph, scope: 'private', path, mtimeMs, exists };
}

export async function loadCompanyKnowledgeGraph(
  companyId: string,
): Promise<ScopedKnowledgeGraph> {
  const path = getCompanyMemoryFilePath(companyId);
  const { graph, mtimeMs, exists } = await parseKnowledgeGraphJsonl(path);
  return { ...graph, scope: 'company', path, mtimeMs, exists };
}

/** Same substring rules as MCP server-memory search_nodes. */
export function searchKnowledgeGraph(graph: KnowledgeGraph, query: string): KnowledgeGraph {
  const q = query.trim().toLowerCase();
  if (!q) return graph;

  const entities = graph.entities.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.entityType.toLowerCase().includes(q) ||
      e.observations.some((o) => o.toLowerCase().includes(q)),
  );
  const names = new Set(entities.map((e) => e.name));
  const relations = graph.relations.filter((r) => names.has(r.from) || names.has(r.to));
  return { entities, relations };
}

export function mergeKnowledgeGraphs(
  graphs: Array<{ scope: KnowledgeGraphScope; graph: KnowledgeGraph }>,
): MergedKnowledgeGraph {
  const entityMap = new Map<string, AttributedKgEntity>();
  const relationMap = new Map<string, AttributedKgRelation>();

  for (const { scope, graph } of graphs) {
    for (const e of graph.entities) {
      const existing = entityMap.get(e.name);
      if (!existing) {
        entityMap.set(e.name, {
          name: e.name,
          entityType: e.entityType,
          observations: [...e.observations],
          sources: [scope],
        });
      } else {
        if (!existing.sources.includes(scope)) existing.sources.push(scope);
        for (const obs of e.observations) {
          if (!existing.observations.includes(obs)) existing.observations.push(obs);
        }
      }
    }
    for (const r of graph.relations) {
      const key = `${r.from}|${r.relationType}|${r.to}`;
      const existing = relationMap.get(key);
      if (!existing) {
        relationMap.set(key, { ...r, sources: [scope] });
      } else if (!existing.sources.includes(scope)) {
        existing.sources.push(scope);
      }
    }
  }

  return {
    entities: [...entityMap.values()],
    relations: [...relationMap.values()],
  };
}
