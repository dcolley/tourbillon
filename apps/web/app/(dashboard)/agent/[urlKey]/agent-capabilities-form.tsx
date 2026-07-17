'use client';

import { useMemo, useRef, useState } from 'react';
import { GRANULAR_TOOL_GROUPS, type ToolCapability } from '@tourbillon/shared/tool-catalog';
import {
  AGENT_INTEGRATION_CREDENTIALS,
  TOOLSET_CATALOG,
  type AgentIntegrationCredentialId,
} from '@tourbillon/shared/constants';

export type AgentIntegrationOverrides = Partial<Record<AgentIntegrationCredentialId, string>>;

interface IntegrationRow {
  rowId: string;
  key: AgentIntegrationCredentialId | '';
  /** True when this row was loaded from a stored override (empty password = keep). */
  hasStoredValue: boolean;
}

interface AgentCapabilitiesFormProps {
  agentId: string;
  urlKey: string;
  assignedToolsets: string[];
  enabledTools: string[];
  integrationOverrides?: AgentIntegrationOverrides;
  updateCapabilities: (formData: FormData) => Promise<void>;
}

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

export function AgentCapabilitiesForm({
  agentId,
  urlKey,
  assignedToolsets,
  enabledTools,
  integrationOverrides = {},
  updateCapabilities,
}: AgentCapabilitiesFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [rows, setRows] = useState<IntegrationRow[]>(() => initialRows(integrationOverrides));
  const [clearedKeys, setClearedKeys] = useState<AgentIntegrationCredentialId[]>([]);

  const usedKeys = useMemo(
    () => new Set(rows.map((row) => row.key).filter(Boolean) as AgentIntegrationCredentialId[]),
    [rows],
  );

  const availableKeys = AGENT_INTEGRATION_CREDENTIALS.filter((entry) => !usedKeys.has(entry.id));

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
    <form ref={formRef} action={updateCapabilities} className="space-y-6 border-t pt-4">
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
            return (
              <li key={entry.id}>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    name={`toolset_${entry.id}`}
                    defaultChecked={checked}
                    className="mt-0.5 rounded border-input"
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

      <button
        type="submit"
        className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
      >
        Save capabilities
      </button>
    </form>
  );
}
