'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { GRANULAR_TOOL_GROUPS, type ToolCapability } from '@tourbillon/shared/tool-catalog';
import {
  AGENT_INTEGRATION_CREDENTIALS,
  CONTROL_PLANE_SKILL_SLUG,
  SKILL_CATALOG,
  TOOLSET_CATALOG,
  type AgentIntegrationCredentialId,
} from '@tourbillon/shared/constants';
import { getMcpBridgedToolsetIds } from '@tourbillon/shared/mcp-builtin-catalog';
import type { AgentRuntimeConfig } from '@tourbillon/shared/types';
import type { ActionResult } from '@/lib/action-result';
import { useActionToast } from '@/hooks/use-action-toast';
import { ActionSubmitButton } from '@/components/action-form';

export type AgentIntegrationOverrides = Partial<Record<AgentIntegrationCredentialId, string>>;

interface IntegrationRow {
  rowId: string;
  key: AgentIntegrationCredentialId | '';
  /** True when this row was loaded from a stored override (empty password = keep). */
  hasStoredValue: boolean;
}

interface McpToolCatalogEntry {
  name: string;
  description?: string;
}

interface McpServerToolCatalog {
  serverId: string;
  label: string;
  tools: McpToolCatalogEntry[];
  toolWhitelist?: string[];
  toolBlacklist?: string[];
  error?: string;
}

interface ToggleableMcpServer {
  id: string;
  label: string;
  source: string;
}

interface AgentCapabilitiesFormProps {
  agentId: string;
  urlKey: string;
  assignedSkills: string[];
  companySkillSlugs: string[];
  assignedToolsets: string[];
  assignedMcpServerIds: string[];
  toggleableMcpServers: ToggleableMcpServer[];
  enabledTools: string[];
  mcpToolPolicy?: AgentRuntimeConfig['mcpToolPolicy'];
  knowledgeGraph?: AgentRuntimeConfig['knowledgeGraph'];
  integrationOverrides?: AgentIntegrationOverrides;
  updateCapabilities: (
    prev: ActionResult | null,
    formData: FormData,
  ) => Promise<ActionResult>;
}

const MCP_BRIDGED_TOOLSET_IDS = new Set(getMcpBridgedToolsetIds());

function nextRowId(): string {
  return `row_${Math.random().toString(36).slice(2, 10)}`;
}

function initialRows(overrides: AgentIntegrationOverrides): IntegrationRow[] {
  const rows: IntegrationRow[] = [];
  for (const entry of AGENT_INTEGRATION_CREDENTIALS) {
    if (overrides[entry.id]?.trim()) {
      rows.push({ rowId: nextRowId(), key: entry.id, hasStoredValue: true });
    }
  }
  return rows;
}

function matchesToolName(toolName: string, pattern: string): boolean {
  return toolName === pattern || toolName.endsWith(`_${pattern}`) || toolName.includes(pattern);
}

function isToolDeniedByBlacklist(toolName: string, blacklist: string[] | undefined): boolean {
  if (!blacklist?.length) return false;
  return blacklist.some((pattern) => matchesToolName(toolName, pattern));
}

function defaultToolChecked(
  toolName: string,
  server: McpServerToolCatalog,
  policy: AgentRuntimeConfig['mcpToolPolicy'] | undefined,
): boolean {
  const storedAllow =
    policy?.[server.serverId]?.allow ??
    (server.serverId === 'memory-mcp-private' ? policy?.['memory-mcp']?.allow : undefined);
  if (storedAllow !== undefined) {
    return storedAllow.some((pattern) => matchesToolName(toolName, pattern));
  }
  if (server.toolWhitelist?.length) {
    return server.toolWhitelist.some((pattern) => matchesToolName(toolName, pattern));
  }
  return !isToolDeniedByBlacklist(toolName, server.toolBlacklist);
}

function readCheckedToolsets(form: HTMLFormElement): string[] {
  const ids: string[] = [];
  for (const entry of TOOLSET_CATALOG) {
    if (entry.id === 'code-execution') continue;
    const input = form.elements.namedItem(`toolset_${entry.id}`) as HTMLInputElement | null;
    if (input?.checked) ids.push(entry.id);
  }
  return ids;
}

function readCheckedMcpServerIds(form: HTMLFormElement): string[] {
  const inputs = form.querySelectorAll<HTMLInputElement>('input[name="mcpServerId"]');
  const ids: string[] = [];
  for (const input of inputs) {
    if (input.checked && input.value) ids.push(input.value);
  }
  return ids;
}

export function AgentCapabilitiesForm({
  agentId,
  urlKey,
  assignedSkills,
  companySkillSlugs,
  assignedToolsets,
  assignedMcpServerIds,
  toggleableMcpServers,
  enabledTools,
  mcpToolPolicy,
  knowledgeGraph,
  integrationOverrides = {},
  updateCapabilities,
}: AgentCapabilitiesFormProps) {
  const [state, formAction] = useActionState(updateCapabilities, null);
  useActionToast(state);
  const formRef = useRef<HTMLFormElement>(null);
  const [rows, setRows] = useState<IntegrationRow[]>(() => initialRows(integrationOverrides));
  const [clearedKeys, setClearedKeys] = useState<AgentIntegrationCredentialId[]>([]);
  const [previewToolsets, setPreviewToolsets] = useState<string[]>(() =>
    assignedToolsets.filter((id) => id !== 'code-execution'),
  );
  const [previewMcpServerIds, setPreviewMcpServerIds] = useState<string[]>(() => [
    ...assignedMcpServerIds,
  ]);
  const [kgPrivate, setKgPrivate] = useState(knowledgeGraph?.private !== false);
  const [kgCompany, setKgCompany] = useState(knowledgeGraph?.company === true);
  const [mcpServers, setMcpServers] = useState<McpServerToolCatalog[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const usedKeys = useMemo(
    () => new Set(rows.map((row) => row.key).filter(Boolean) as AgentIntegrationCredentialId[]),
    [rows],
  );

  const availableKeys = AGENT_INTEGRATION_CREDENTIALS.filter((entry) => !usedKeys.has(entry.id));

  const showKnowledgeGraphMounts = previewToolsets.includes('knowledge-graph');

  const bundledSkillIds = new Set<string>(SKILL_CATALOG.map((entry) => entry.id));
  const extraCompanySkills = companySkillSlugs.filter((slug) => !bundledSkillIds.has(slug));

  const mcpPreviewKey = useMemo(() => {
    const bridged = previewToolsets.filter((id) => MCP_BRIDGED_TOOLSET_IDS.has(id)).sort();
    const servers = [...previewMcpServerIds].sort();
    return `${bridged.join(',')}|mcp:${servers.join(',')}|kg:${kgPrivate ? 'p' : ''}${kgCompany ? 'c' : ''}`;
  }, [previewToolsets, previewMcpServerIds, kgPrivate, kgCompany]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setMcpLoading(true);
      setMcpError(null);
      try {
        const params = new URLSearchParams();
        params.set('toolsets', previewToolsets.join(','));
        params.set('mcpServers', previewMcpServerIds.join(','));
        if (previewToolsets.includes('knowledge-graph')) {
          params.set('kgPrivate', kgPrivate ? '1' : '0');
          params.set('kgCompany', kgCompany ? '1' : '0');
        }
        const res = await fetch(`/api/agents/${agentId}/mcp-tools?${params.toString()}`);
        const data = (await res.json()) as { servers?: McpServerToolCatalog[]; error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? `Failed to load MCP tools (${res.status})`);
        }
        if (!cancelled) {
          setMcpServers(data.servers ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setMcpServers([]);
          setMcpError(err instanceof Error ? err.message : 'Failed to load MCP tools');
        }
      } finally {
        if (!cancelled) setMcpLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId, mcpPreviewKey, previewToolsets, previewMcpServerIds, kgPrivate, kgCompany]);

  function syncPreviewToolsetsFromForm() {
    const form = formRef.current;
    if (!form) return;
    setPreviewToolsets(readCheckedToolsets(form));
  }

  function syncPreviewMcpServersFromForm() {
    const form = formRef.current;
    if (!form) return;
    setPreviewMcpServerIds(readCheckedMcpServerIds(form));
  }

  function toggleGroupCapability(groupId: string, capability: ToolCapability | 'none') {
    const form = formRef.current;
    if (!form) return;

    const group = GRANULAR_TOOL_GROUPS.find((g) => g.id === groupId);
    if (!group) return;

    for (const tool of group.tools) {
      const input = form.elements.namedItem(`tool_${tool.id}`) as HTMLInputElement | null;
      if (!input) continue;

      if (capability === 'none') {
        input.checked = false;
      } else {
        input.checked = tool.capability === capability;
      }
    }
  }

  function setAllMcpTools(serverId: string, checked: boolean) {
    const form = formRef.current;
    if (!form) return;
    const inputs = form.querySelectorAll<HTMLInputElement>(
      `input[name="mcpAllow_${serverId}"]`,
    );
    for (const input of inputs) {
      input.checked = checked;
    }
  }

  function addRow() {
    if (availableKeys.length === 0) return;
    setRows((prev) => [
      ...prev,
      { rowId: nextRowId(), key: availableKeys[0]!.id, hasStoredValue: false },
    ]);
  }

  function updateRowKey(rowId: string, key: AgentIntegrationCredentialId | '') {
    const row = rows.find((r) => r.rowId === rowId);
    if (row?.key && row.hasStoredValue && row.key !== key) {
      const previousKey = row.key;
      setClearedKeys((keys) => (keys.includes(previousKey) ? keys : [...keys, previousKey]));
    }
    setRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, key, hasStoredValue: false } : r)),
    );
  }

  function removeRow(rowId: string) {
    const row = rows.find((r) => r.rowId === rowId);
    if (row?.key && row.hasStoredValue) {
      const key = row.key;
      setClearedKeys((keys) => (keys.includes(key) ? keys : [...keys, key]));
    }
    setRows((prev) => prev.filter((r) => r.rowId !== rowId));
  }

  return (
    <form
      key={JSON.stringify(mcpToolPolicy ?? null)}
      ref={formRef}
      action={formAction}
      className="space-y-6 border-t pt-4"
    >
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="urlKey" value={urlKey} />
      {clearedKeys.map((key) => (
        <input key={`clear_${key}`} type="hidden" name="clearIntegration" value={key} />
      ))}

      <div>
        <p className="text-sm font-medium">Tools</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Tier 1 control-plane tools (inbox, checkout, update issue, subtasks) are always included.
        </p>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium">Skills</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Methodology playbooks. Control plane is always on and inlined; other skills appear in the
            catalog and load via getSkill when needed.
          </p>
        </div>
        <ul className="space-y-3">
          {SKILL_CATALOG.map((entry) => {
            const isControlPlane = entry.id === CONTROL_PLANE_SKILL_SLUG;
            const checked = isControlPlane || assignedSkills.includes(entry.id);
            return (
              <li key={entry.id}>
                <label
                  className={`flex items-start gap-2 ${isControlPlane ? 'cursor-default' : 'cursor-pointer'}`}
                >
                  {isControlPlane ? (
                    <input type="hidden" name={`skill_${entry.id}`} value="on" />
                  ) : null}
                  <input
                    type="checkbox"
                    name={isControlPlane ? undefined : `skill_${entry.id}`}
                    defaultChecked={checked}
                    disabled={isControlPlane}
                    className="mt-0.5 rounded border-input"
                  />
                  <span>
                    <span className="font-medium">{entry.label}</span>
                    <span className="ml-2 text-[10px] font-mono text-muted-foreground">{entry.id}</span>
                    <span className="block text-xs text-muted-foreground">{entry.description}</span>
                  </span>
                </label>
              </li>
            );
          })}
          {extraCompanySkills.map((slug) => (
            <li key={slug}>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  name={`skill_${slug}`}
                  defaultChecked={assignedSkills.includes(slug)}
                  className="mt-0.5 rounded border-input"
                />
                <span>
                  <span className="font-medium">{slug}</span>
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                    company
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Company workspace skill from skills/{slug}.md
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      {GRANULAR_TOOL_GROUPS.map((group) => {
        const hasRead = group.tools.some((t) => t.capability === 'read');
        const hasWrite = group.tools.some((t) => t.capability === 'write');

        return (
          <fieldset key={group.id} className="space-y-3 rounded-md border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <legend className="text-sm font-medium">{group.label}</legend>
              <div className="flex flex-wrap gap-2">
                {hasRead && (
                  <button
                    type="button"
                    onClick={() => toggleGroupCapability(group.id, 'read')}
                    className="text-xs rounded border px-2 py-0.5 hover:bg-muted"
                  >
                    All read
                  </button>
                )}
                {hasWrite && (
                  <button
                    type="button"
                    onClick={() => toggleGroupCapability(group.id, 'write')}
                    className="text-xs rounded border px-2 py-0.5 hover:bg-muted"
                  >
                    All write
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => toggleGroupCapability(group.id, 'none')}
                  className="text-xs rounded border px-2 py-0.5 hover:bg-muted"
                >
                  None
                </button>
              </div>
            </div>

            <ul className="space-y-2">
              {group.tools.map((tool) => (
                <li key={tool.id}>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      name={`tool_${tool.id}`}
                      defaultChecked={enabledTools.includes(tool.id)}
                      className="mt-0.5 rounded border-input"
                    />
                    <span>
                      <span className="font-medium text-sm">{tool.label}</span>
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {tool.capability}
                      </span>
                      <span className="block text-xs text-muted-foreground">{tool.description}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        );
      })}

      <div className="space-y-3">
        <p className="text-sm font-medium">Boolean toolsets</p>
        <ul className="space-y-3">
          {TOOLSET_CATALOG.filter((entry) => entry.id !== 'code-execution').map((entry) => {
            const checked =
              assignedToolsets.includes(entry.id) ||
              (entry.id === 'roster' && assignedToolsets.includes('agent-management'));
            const isMcpBridged = MCP_BRIDGED_TOOLSET_IDS.has(entry.id);
            return (
              <li key={entry.id}>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    name={`toolset_${entry.id}`}
                    defaultChecked={checked}
                    className="mt-0.5 rounded border-input"
                    onChange={isMcpBridged ? syncPreviewToolsetsFromForm : undefined}
                  />
                  <span>
                    <span className="font-medium">{entry.label}</span>
                    <span className="block text-xs text-muted-foreground">{entry.description}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      {showKnowledgeGraphMounts && (
        <div className="space-y-3 rounded-md border p-4">
          <div>
            <p className="text-sm font-medium">Knowledge graph mounts</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Each mount is a separate MCP memory file. Writes always target one scope — not a silent union.
              Defaults: private on, company off.
            </p>
          </div>
          <ul className="space-y-3">
            <li>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  name="kgMountPrivate"
                  checked={kgPrivate}
                  onChange={(e) => setKgPrivate(e.target.checked)}
                  className="mt-0.5 rounded border-input"
                />
                <span>
                  <span className="font-medium text-sm">Private memory</span>
                  <span className="block text-xs text-muted-foreground font-mono">
                    agents/{urlKey}/memory.jsonl
                  </span>
                </span>
              </label>
            </li>
            <li>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  name="kgMountCompany"
                  checked={kgCompany}
                  onChange={(e) => setKgCompany(e.target.checked)}
                  className="mt-0.5 rounded border-input"
                />
                <span>
                  <span className="font-medium text-sm">Company memory</span>
                  <span className="block text-xs text-muted-foreground font-mono">memory.jsonl</span>
                </span>
              </label>
            </li>
          </ul>
          {!kgPrivate && !kgCompany && (
            <p className="text-xs text-destructive">
              Enable at least one mount or the knowledge-graph toolset will expose no memory tools.
            </p>
          )}
        </div>
      )}

      <div className="space-y-3 rounded-md border p-4">
        <div>
          <p className="text-sm font-medium">MCP servers</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Enable servers declared in <span className="font-mono">mcp.json</span> (and builtins such as
            Buffer/GitHub). Buffer and knowledge-graph toolsets above still attach their servers
            automatically.
          </p>
        </div>
        {toggleableMcpServers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No toggleable MCP servers. Add entries to <span className="font-mono">mcp.json</span> (see{' '}
            <span className="font-mono">mcp.json.example</span>) and restart web/workers.
          </p>
        ) : (
          <ul className="space-y-3">
            {toggleableMcpServers.map((server) => (
              <li key={server.id}>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    name="mcpServerId"
                    value={server.id}
                    defaultChecked={assignedMcpServerIds.includes(server.id)}
                    className="mt-0.5 rounded border-input"
                    onChange={syncPreviewMcpServersFromForm}
                  />
                  <span>
                    <span className="font-medium text-sm">{server.label}</span>
                    <span className="ml-2 text-[10px] font-mono text-muted-foreground">{server.id}</span>
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {server.source}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 rounded-md border p-4">
        <div>
          <p className="text-sm font-medium">MCP tools</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Live tool list from each assigned MCP server. Uncheck tools to hide them at wake. Enabling an MCP
            server or toolset may take a few seconds to load.
          </p>
        </div>

        {mcpLoading && (
          <p className="text-xs text-muted-foreground">Loading MCP tool catalogs…</p>
        )}
        {mcpError && <p className="text-xs text-destructive">{mcpError}</p>}
        {!mcpLoading && !mcpError && mcpServers.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No MCP servers assigned. Enable a server above, or Buffer / Knowledge graph memory toolsets.
          </p>
        )}

        {mcpServers.map((server) => (
          <fieldset key={server.serverId} className="space-y-3 rounded-md border p-3">
            {!server.error ? (
              <input type="hidden" name="mcpServerPolicy" value={server.serverId} />
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <legend className="text-sm font-medium">{server.label}</legend>
              {!server.error && server.tools.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setAllMcpTools(server.serverId, true)}
                    className="text-xs rounded border px-2 py-0.5 hover:bg-muted"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setAllMcpTools(server.serverId, false)}
                    className="text-xs rounded border px-2 py-0.5 hover:bg-muted"
                  >
                    None
                  </button>
                </div>
              )}
            </div>
            <p className="text-[10px] font-mono text-muted-foreground">{server.serverId}</p>
            {server.error ? (
              <p className="text-xs text-destructive">{server.error}</p>
            ) : server.tools.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tools returned.</p>
            ) : (
              <ul className="space-y-2">
                {server.tools.map((tool) => (
                  <li key={tool.name}>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        name={`mcpAllow_${server.serverId}`}
                        value={tool.name}
                        defaultChecked={defaultToolChecked(tool.name, server, mcpToolPolicy)}
                        className="mt-0.5 rounded border-input"
                      />
                      <span>
                        <span className="font-medium text-sm font-mono">{tool.name}</span>
                        {tool.description ? (
                          <span className="block text-xs text-muted-foreground">{tool.description}</span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        ))}
      </div>

      <div className="space-y-3 rounded-md border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Integration credentials</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Optional per-agent key/value overrides. Leave blank to keep an existing secret, or remove a row to clear
              it. Falls back to company settings or env.
            </p>
          </div>
          <button
            type="button"
            onClick={addRow}
            disabled={availableKeys.length === 0}
            className="text-xs rounded border px-2 py-1 hover:bg-muted disabled:opacity-50"
          >
            Add credential
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No agent-level overrides. Company or env values still apply.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => {
              const meta = AGENT_INTEGRATION_CREDENTIALS.find((entry) => entry.id === row.key);
              const keyOptions = AGENT_INTEGRATION_CREDENTIALS.filter(
                (entry) => entry.id === row.key || !usedKeys.has(entry.id),
              );
              return (
                <li key={row.rowId} className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_1fr_auto] sm:items-end">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor={`integration_key_${row.rowId}`}>
                      Key
                    </label>
                    <select
                      id={`integration_key_${row.rowId}`}
                      name="integrationKey"
                      value={row.key}
                      onChange={(e) =>
                        updateRowKey(row.rowId, e.target.value as AgentIntegrationCredentialId | '')
                      }
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      required
                    >
                      {keyOptions.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label
                      className="text-xs font-medium text-muted-foreground"
                      htmlFor={`integration_value_${row.rowId}`}
                    >
                      Value
                    </label>
                    <input
                      id={`integration_value_${row.rowId}`}
                      name="integrationValue"
                      type={meta?.inputType ?? 'text'}
                      placeholder={
                        row.hasStoredValue
                          ? '•••••••• (leave blank to keep)'
                          : meta
                            ? `Uses company or ${meta.envHint}`
                            : 'Value'
                      }
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                      autoComplete="off"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRow(row.rowId)}
                    className="text-xs rounded border px-2 py-2 hover:bg-muted self-end"
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ActionSubmitButton label="Save capabilities" />
    </form>
  );
}
