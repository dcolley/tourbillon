/**
 * #348 — Studio hydration: register every DB agent on the single Mastra
 * instance with its FULL production tool set (Derek's item 6: no
 * tool-stripped copies), so Mastra Studio on the LAN can list and run them.
 *
 * Side effects, deliberately accepted for internal use (see PR):
 *  - any LAN/Tailscale caller can list ALL companies' agents (cross-tenant
 *    visibility) and generate runs against the SHARED DB (writes included).
 *  - Company-Computer tools are the one exclusion (C3e / PM ruling Q5): the
 *    'company-computer' toolset is dropped from the record AND the CC tool
 *    keys are filtered from the assembled map, so CC stays dark from Studio.
 *
 * All dependencies are injectable — tests run hydration against fakes; the
 * defaults mirror wake-runner's production options exactly.
 */
import { db, agents as agentsTable, companies as companiesTable } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import type { Agent as AgentRecord, Company } from '@tourbillon/db';
import { parseCompanySettings } from '@tourbillon/shared';
import { Agent } from '@mastra/core/agent';
// Relative imports keep Next out of the package barrel (same pattern as
// apps/web/lib/chat/registry.ts).
import { createAgentWithSkills } from '../../../../packages/mastra/src/agent-factory';
import { getMastraInstance } from '../../../../packages/mastra/src/mastra-instance';

/** Toolset ids Studio never assembles, even when assigned (C3e). */
export const STUDIO_EXCLUDED_TOOLSET_IDS: readonly string[] = ['company-computer'];

/**
 * Keys of COMPANY_COMPUTER_TOOLS (packages/mastra/src/tools/company-computer-tools.ts).
 * Kept as an explicit list + prefix backstop: if a CC tool is added under the
 * computer* prefix the filter keeps holding; C3e's mutant (drop the filter)
 * turns the test red.
 */
const CC_TOOL_KEYS: ReadonlySet<string> = new Set([
  'computerOpenBrowserTool',
  'computerScreenshotTool',
  'computerClickTool',
  'computerTypeTextTool',
  'computerCloseSessionTool',
  'computerGetSessionInfoTool',
  'computerOpenFileManagerTool',
  'computerOpenTerminalTool',
  'computerPressKeyTool',
  'computerMouseMoveTool',
  'computerScrollTool',
]);

export function isCompanyComputerToolKey(key: string): boolean {
  return CC_TOOL_KEYS.has(key) || /^computer[A-Z]/.test(key);
}

/** Drop CC tools from an assembled tool map (last-mile, after MCP/redaction). */
export function dropCompanyComputerTools(
  tools: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tools)) {
    if (isCompanyComputerToolKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Copy with excluded toolsets removed (belt to dropCompanyComputerTools' braces). */
export function studioAgentRecordForBuild(record: AgentRecord): AgentRecord {
  return {
    ...record,
    assignedToolsets: (record.assignedToolsets ?? []).filter(
      (id) => !STUDIO_EXCLUDED_TOOLSET_IDS.includes(id),
    ),
  };
}

export interface StudioHydrationDeps {
  listAgentRows: () => Promise<AgentRecord[]>;
  getCompany: (companyId: string) => Promise<Company | null>;
  buildAgent: (
    record: AgentRecord,
    options: {
      allowedMcpServerIds: string[];
      companySettings: unknown;
      toolFilter: (tools: Record<string, unknown>) => Record<string, unknown>;
    },
  ) => Promise<unknown>;
  register: (agentId: string, agent: unknown) => void;
}

export interface StudioHydrationResult {
  /** Agent ids registered with their full tool set. */
  hydrated: string[];
  /** Agent ids whose build failed — still registered as list-only fallbacks. */
  failed: string[];
}

async function defaultListAgentRows(): Promise<AgentRecord[]> {
  return await db.select().from(agentsTable);
}

async function defaultGetCompany(companyId: string): Promise<Company | null> {
  const rows = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  return rows[0] ?? null;
}

function defaultRegister(agentId: string, agent: unknown): void {
  const mastra = getMastraInstance();
  try {
    mastra.removeAgent(agentId);
  } catch {
    // not registered yet
  }
  mastra.addAgent(agent as never, agentId);
}

/**
 * List-only fallback: a broken row must not erase the OTHER agents from
 * Studio, and C3a requires the list to equal the DB rows. Fallback agents
 * carry no tools and no usable model (a generate against them 500s inside the
 * adapter — loud, never silent).
 */
function listOnlyFallback(record: AgentRecord): unknown {
  return new Agent({
    id: record.id,
    name: record.name,
    instructions: 'Studio list-only fallback — agent build failed.',
    model: 'openai/gpt-4o-mini',
  });
}

async function runHydration(deps: StudioHydrationDeps): Promise<StudioHydrationResult> {
  const hydrated: string[] = [];
  const failed: string[] = [];
  const rows = await deps.listAgentRows();
  for (const row of rows) {
    const company = await deps.getCompany(row.companyId);
    const buildRecord = studioAgentRecordForBuild(row);
    try {
      const agent = await deps.buildAgent(buildRecord, {
        allowedMcpServerIds: company?.allowedMcpServerIds ?? [],
        companySettings: parseCompanySettings(company?.settings),
        toolFilter: dropCompanyComputerTools,
      });
      deps.register(row.id, agent);
      hydrated.push(row.id);
    } catch {
      deps.register(row.id, listOnlyFallback(row));
      failed.push(row.id);
    }
  }
  return { hydrated, failed };
}

const defaultDeps: StudioHydrationDeps = {
  listAgentRows: defaultListAgentRows,
  getCompany: defaultGetCompany,
  buildAgent: (record, options) =>
    createAgentWithSkills(record, {
      allowedMcpServerIds: options.allowedMcpServerIds,
      companySettings: options.companySettings as never,
      toolFilter: options.toolFilter,
    }),
  register: defaultRegister,
};

const globalForStudioHydration = globalThis as unknown as {
  tourbillonStudioHydration?: {
    promise: Promise<StudioHydrationResult>;
    startedAt: number;
  };
};

/** Drop the cache (tests, or to force a re-read after an agent edit). */
export function resetStudioHydrationCache(): void {
  delete globalForStudioHydration.tourbillonStudioHydration;
}

/**
 * Hydrate once per TTL (default 60s) per process. Concurrent callers share
 * the same in-flight promise; a failed run is not cached (next request
 * retries). Never throws to the caller unless hydration itself fails, in
 * which case the route answers 500 (no partial list is served).
 */
export async function ensureStudioAgentsHydrated(opts?: {
  maxAgeMs?: number;
  deps?: Partial<StudioHydrationDeps>;
}): Promise<StudioHydrationResult> {
  const maxAge = opts?.maxAgeMs ?? 60_000;
  const cached = globalForStudioHydration.tourbillonStudioHydration;
  if (cached && Date.now() - cached.startedAt < maxAge) return cached.promise;
  const merged: StudioHydrationDeps = { ...defaultDeps, ...(opts?.deps ?? {}) };
  const startedAt = Date.now();
  const promise = runHydration(merged).catch((err) => {
    if (globalForStudioHydration.tourbillonStudioHydration?.promise === promise) {
      delete globalForStudioHydration.tourbillonStudioHydration;
    }
    throw err;
  });
  globalForStudioHydration.tourbillonStudioHydration = { promise, startedAt };
  return promise;
}
