'use client';

import { useEffect, useMemo, useState } from 'react';

export type KgViewScope = 'private' | 'company' | 'both';

export interface KgEntityView {
  name: string;
  entityType: string;
  observations: string[];
  sources?: Array<'private' | 'company'>;
}

export interface KgRelationView {
  from: string;
  to: string;
  relationType: string;
  sources?: Array<'private' | 'company'>;
}

interface KnowledgeGraphPanelProps {
  entities: KgEntityView[];
  relations: KgRelationView[];
  emptyMessage?: string;
}

function SourceBadges({ sources }: { sources?: Array<'private' | 'company'> }) {
  if (!sources?.length) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1">
      {sources.map((s) => (
        <span
          key={s}
          className="rounded border px-1.5 py-0 text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          {s}
        </span>
      ))}
    </span>
  );
}

/** Lightweight force-free SVG layout: entities in a circle, relations as arcs. */
function KnowledgeGraphViz({
  entities,
  relations,
}: {
  entities: KgEntityView[];
  relations: KgRelationView[];
}) {
  const layout = useMemo(() => {
    const n = entities.length;
    const cx = 200;
    const cy = 160;
    const r = Math.min(130, 40 + n * 8);
    const positions = new Map<string, { x: number; y: number }>();
    entities.forEach((e, i) => {
      const angle = n === 1 ? -Math.PI / 2 : (i / n) * Math.PI * 2 - Math.PI / 2;
      positions.set(e.name, {
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
      });
    });
    return { positions, cx, cy };
  }, [entities]);

  if (entities.length === 0) return null;

  return (
    <svg
      viewBox="0 0 400 320"
      className="w-full max-h-80 rounded-md border bg-muted/20"
      role="img"
      aria-label="Knowledge graph visualization"
    >
      {relations.map((rel, i) => {
        const from = layout.positions.get(rel.from);
        const to = layout.positions.get(rel.to);
        if (!from || !to) return null;
        return (
          <g key={`${rel.from}-${rel.relationType}-${rel.to}-${i}`}>
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeWidth={1.25}
            />
            <text
              x={(from.x + to.x) / 2}
              y={(from.y + to.y) / 2 - 4}
              className="fill-muted-foreground"
              fontSize={8}
              textAnchor="middle"
            >
              {rel.relationType}
            </text>
          </g>
        );
      })}
      {entities.map((e) => {
        const pos = layout.positions.get(e.name);
        if (!pos) return null;
        return (
          <g key={e.name}>
            <circle cx={pos.x} cy={pos.y} r={14} className="fill-background stroke-border" strokeWidth={1.5} />
            <text
              x={pos.x}
              y={pos.y + 28}
              className="fill-foreground"
              fontSize={9}
              textAnchor="middle"
            >
              {e.name.length > 18 ? `${e.name.slice(0, 16)}…` : e.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function KnowledgeGraphPanel({
  entities,
  relations,
  emptyMessage = 'No entities in this scope yet.',
}: KnowledgeGraphPanelProps) {
  if (entities.length === 0 && relations.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-4">
      <KnowledgeGraphViz entities={entities} relations={relations} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">
            Entities <span className="text-muted-foreground font-normal">({entities.length})</span>
          </h3>
          <ul className="max-h-80 space-y-2 overflow-y-auto text-sm">
            {entities.map((e) => (
              <li key={`${e.name}-${e.sources?.join(',') ?? ''}`} className="rounded-md border p-3">
                <p className="font-medium">
                  {e.name}
                  <SourceBadges sources={e.sources} />
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{e.entityType}</p>
                {e.observations.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                    {e.observations.map((obs, i) => (
                      <li key={i}>{obs}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">
            Relations <span className="text-muted-foreground font-normal">({relations.length})</span>
          </h3>
          {relations.length === 0 ? (
            <p className="text-xs text-muted-foreground">No relations.</p>
          ) : (
            <ul className="max-h-80 space-y-2 overflow-y-auto text-sm">
              {relations.map((r, i) => (
                <li
                  key={`${r.from}-${r.relationType}-${r.to}-${i}`}
                  className="rounded-md border p-3 font-mono text-xs"
                >
                  <span>{r.from}</span>
                  <span className="mx-1.5 text-muted-foreground">—{r.relationType}→</span>
                  <span>{r.to}</span>
                  <SourceBadges sources={r.sources} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

interface AgentMemoryTabProps {
  agentId: string;
  urlKey: string;
  hasKnowledgeGraphToolset: boolean;
}

export function AgentMemoryTab({ agentId, urlKey, hasKnowledgeGraphToolset }: AgentMemoryTabProps) {
  const [scope, setScope] = useState<KgViewScope>('private');
  const [query, setQuery] = useState('');
  const [entities, setEntities] = useState<KgEntityView[]>([]);
  const [relations, setRelations] = useState<KgRelationView[]>([]);
  const [meta, setMeta] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ scope });
        if (query.trim()) params.set('q', query.trim());
        const res = await fetch(`/api/agents/${agentId}/knowledge-graph?${params.toString()}`);
        const data = (await res.json()) as {
          error?: string;
          entities?: KgEntityView[];
          relations?: KgRelationView[];
          path?: string;
          exists?: boolean;
          sources?: {
            private: { path: string; exists: boolean };
            company: { path: string; exists: boolean };
          };
        };
        if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
        if (cancelled) return;
        setEntities(data.entities ?? []);
        setRelations(data.relations ?? []);
        if (data.sources) {
          setMeta(
            `Private: ${data.sources.private.path}${data.sources.private.exists ? '' : ' (missing)'} · Company: ${data.sources.company.path}${data.sources.company.exists ? '' : ' (missing)'}`,
          );
        } else if (data.path) {
          setMeta(`${data.path}${data.exists === false ? ' (file not created yet)' : ''}`);
        } else {
          setMeta(null);
        }
      } catch (err) {
        if (!cancelled) {
          setEntities([]);
          setRelations([]);
          setError(err instanceof Error ? err.message : 'Failed to load memory');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId, scope, query]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Knowledge graph memory</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Read-only view of JSONL memory files. Agents write via MCP when the knowledge-graph toolset is enabled.
          {!hasKnowledgeGraphToolset && (
            <> Enable the <span className="font-medium">Knowledge graph</span> toolset under Capabilities to mount
              memory at wake.</>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['private', 'company', 'both'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(s)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium capitalize ${
              scope === s ? 'bg-muted' : 'hover:bg-muted/60'
            }`}
          >
            {s}
          </button>
        ))}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="ml-auto w-full max-w-xs rounded-md border border-input bg-background px-3 py-1.5 text-sm sm:w-48"
        />
      </div>

      {meta && <p className="text-[11px] font-mono text-muted-foreground break-all">{meta}</p>}
      {scope === 'private' && (
        <p className="text-xs text-muted-foreground font-mono">agents/{urlKey}/memory.jsonl</p>
      )}

      {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!loading && !error && (
        <KnowledgeGraphPanel entities={entities} relations={relations} />
      )}
    </div>
  );
}
