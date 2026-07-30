/** Knowledge-graph mount config — safe for client bundles (no Node fs). */

export interface KnowledgeGraphMounts {
  private: boolean;
  company: boolean;
}

/** Defaults when knowledge-graph toolset is on: private mounted, company not. */
export function resolveKnowledgeGraphMounts(
  runtime?: { knowledgeGraph?: { private?: boolean; company?: boolean } } | null,
): KnowledgeGraphMounts {
  const kg = runtime?.knowledgeGraph;
  return {
    private: kg?.private !== false,
    company: kg?.company === true,
  };
}
