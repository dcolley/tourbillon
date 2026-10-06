'use client';

import { useActionState, useMemo, useState } from 'react';
import type { AgentRuntimeType, SandboxIsolation } from '@tourbillon/shared';
import type { CodeExecutionAvailability } from '@tourbillon/shared';
import {
  EGRESS_LAN_BLOCKING_NEEDS_BWRAP,
  EGRESS_PRIVATE_RANGES_HELP,
} from '@tourbillon/shared/egress-private-ranges-copy';
import {
  EGRESS_ALLOW_LIST_HELP,
  EGRESS_ALLOW_LIST_ISOLATION_WARNING,
  inferEgressAllowListMode,
  parseEgressAllowListEntry,
  type EgressAllowListMode,
} from '@tourbillon/shared/egress-allow-list';
import type { ActionResult } from '@/lib/action-result';
import { useActionToast } from '@/hooks/use-action-toast';
import { ActionSubmitButton } from '@/components/action-form';

interface AgentCodeExecutionFormProps {
  agentId: string;
  urlKey: string;
  runtimeType: AgentRuntimeType;
  codeExecutionEnabled: boolean;
  availability: CodeExecutionAvailability;
  sandboxPathPreview: string;
  timeoutOverride?: number;
  isolationOverride?: SandboxIsolation;
  allowNetworkOverride?: boolean;
  egressAllowListOverride?: string[];
  updateCodeExecution: (
    prev: ActionResult | null,
    formData: FormData,
  ) => Promise<ActionResult>;
}

export function AgentCodeExecutionForm({
  agentId,
  urlKey,
  runtimeType,
  codeExecutionEnabled,
  availability,
  sandboxPathPreview,
  timeoutOverride,
  isolationOverride,
  allowNetworkOverride,
  egressAllowListOverride,
  updateCodeExecution,
}: AgentCodeExecutionFormProps) {
  const [state, formAction] = useActionState(updateCodeExecution, null);
  useActionToast(state);
  const [enabled, setEnabled] = useState(codeExecutionEnabled);
  const [isolation, setIsolation] = useState(isolationOverride ?? '');
  const [mode, setMode] = useState<EgressAllowListMode>(
    inferEgressAllowListMode(egressAllowListOverride),
  );
  const [entries, setEntries] = useState<string[]>(egressAllowListOverride ?? []);
  const [draft, setDraft] = useState('');

  const draftParse = draft.trim() ? parseEgressAllowListEntry(draft) : null;
  const entryErrors = useMemo(
    () => entries.map((entry) => ({ entry, parse: parseEgressAllowListEntry(entry) })),
    [entries],
  );
  const hasInvalidEntries = entryErrors.some((row) => !row.parse.ok);
  const effectiveIsolation = (isolation || availability.isolation) as SandboxIsolation;
  const showIsolationWarning =
    enabled && (effectiveIsolation === 'none' || effectiveIsolation === 'seatbelt');

  const addDraft = () => {
    const parsed = parseEgressAllowListEntry(draft);
    if (!parsed.ok) return;
    setEntries((current) =>
      current.some((entry) => entry.toLowerCase() === parsed.entry.toLowerCase())
        ? current
        : [...current, parsed.entry],
    );
    setDraft('');
    setMode('list');
  };

  const hasOverrides =
    timeoutOverride !== undefined ||
    isolationOverride !== undefined ||
    allowNetworkOverride !== undefined ||
    egressAllowListOverride !== undefined;

  return (
    <form action={formAction} className="space-y-4 border-t pt-4">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="urlKey" value={urlKey} />
      <input type="hidden" name="egressAllowListMode" value={mode} />
      {mode === 'list' &&
        entries.map((entry) => (
          <input key={entry} type="hidden" name="egressAllowList" value={entry} />
        ))}

      <div className="space-y-2">
        <p className="text-sm font-medium">Runtime type</p>
        <div className="space-y-2 rounded-md border p-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="runtimeType"
              value="agent"
              defaultChecked={runtimeType === 'agent'}
              className="mt-1"
            />
            <span>
              <span className="text-sm font-medium">Agent</span>
              <span className="block text-xs text-muted-foreground">
                Standard heartbeat with durable resume — good for quick scripts and tests
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="runtimeType"
              value="harness"
              defaultChecked={runtimeType === 'harness'}
              className="mt-1"
            />
            <span>
              <span className="text-sm font-medium">Harness</span>
              <span className="block text-xs text-muted-foreground">
                Mastra harness with persistent threads — better for multi-heartbeat coding on one issue
              </span>
            </span>
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Switching runtime type may reset harness thread continuity for this agent.
        </p>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            name="codeExecutionEnabled"
            defaultChecked={codeExecutionEnabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-0.5 rounded border-input"
          />
          <span>
            <span className="text-sm font-medium">Code execution</span>
            <span className="block text-xs text-muted-foreground">
              Isolated sandbox shell and file tools (mastra_workspace_execute_command, read/write/edit
              file). Separate from the company shared workspace.
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            availability.available
              ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200'
              : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
          }`}
        >
          {availability.available ? 'Sandbox ready' : 'Sandbox unavailable'}
        </span>
        {!availability.available && availability.reason && (
          <span className="text-xs text-muted-foreground">{availability.reason}</span>
        )}
      </div>

      <div className="text-xs text-muted-foreground space-y-1">
        <p>
          <span className="font-medium text-foreground">Workspace root:</span>{' '}
          <span className="font-mono">{availability.root}</span>
        </p>
        <p>
          <span className="font-medium text-foreground">Per-issue path:</span>{' '}
          <span className="font-mono">{sandboxPathPreview}</span>
        </p>
        <p>
          Default isolation: <span className="font-mono">{availability.isolation}</span> · timeout:{' '}
          <span className="font-mono">{availability.timeoutMs}ms</span>
        </p>
      </div>

      {enabled && (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">Per-agent sandbox overrides</p>
          <p className="text-xs text-muted-foreground">
            Optional. Leave blank to use environment defaults.
          </p>
          <div className="space-y-2">
            <label htmlFor="codeExecutionTimeoutMs" className="text-sm font-medium">
              Command timeout (ms)
            </label>
            <input
              id="codeExecutionTimeoutMs"
              name="codeExecutionTimeoutMs"
              type="number"
              min={1000}
              step={1000}
              defaultValue={timeoutOverride ?? ''}
              placeholder={String(availability.timeoutMs)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="codeExecutionIsolation" className="text-sm font-medium">
              Isolation backend
            </label>
            <select
              id="codeExecutionIsolation"
              name="codeExecutionIsolation"
              value={isolation}
              onChange={(e) => setIsolation(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Use environment default ({availability.isolation})</option>
              <option value="none">none</option>
              <option value="seatbelt">seatbelt (macOS)</option>
              <option value="bwrap">bwrap (Linux)</option>
            </select>
          </div>

          <div className="space-y-3 border-t pt-3">
            <div>
              <p className="text-sm font-medium">Egress allow-list</p>
              <p className="text-xs text-muted-foreground mt-1">
                When set (including empty), this replaces Allow network. Exact host, *.domain, IPv4,
                or IPv4 CIDR.
              </p>
            </div>
            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="egressAllowListModeRadio"
                  value="off"
                  checked={mode === 'off'}
                  onChange={() => setMode('off')}
                  className="mt-1"
                />
                <span>
                  <span className="text-sm font-medium">Off</span>
                  <span className="block text-xs text-muted-foreground">
                    Use Allow network as today. No allow-list field is stored.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="egressAllowListModeRadio"
                  value="empty"
                  checked={mode === 'empty'}
                  onChange={() => {
                    setMode('empty');
                    setEntries([]);
                  }}
                  className="mt-1"
                />
                <span>
                  <span className="text-sm font-medium">Empty list</span>
                  <span className="block text-xs text-muted-foreground">
                    No sandbox network (<span className="font-mono">[]</span>).
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="egressAllowListModeRadio"
                  value="list"
                  checked={mode === 'list'}
                  onChange={() => setMode('list')}
                  className="mt-1"
                />
                <span>
                  <span className="text-sm font-medium">List of entries</span>
                  <span className="block text-xs text-muted-foreground">
                    Allow only these destinations through the egress proxy.
                  </span>
                </span>
              </label>
            </div>

            {mode === 'off' && (
              <div className="space-y-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    id="codeExecutionAllowNetwork"
                    name="codeExecutionAllowNetwork"
                    type="checkbox"
                    defaultChecked={allowNetworkOverride ?? false}
                    className="mt-0.5 rounded border-input"
                  />
                  <span>
                    <span className="text-sm font-medium">Allow network (sandbox)</span>
                    <span className="block text-xs text-muted-foreground">
                      Dangerous: this lets the agent reach the public internet from code execution via the
                      egress proxy. Private ranges are blocked unless listed explicitly. Only enable for
                      testing agents with strict instructions.
                    </span>
                  </span>
                </label>
              </div>
            )}

            {mode === 'list' && (
              <div className="space-y-2">
                <label htmlFor="egressAllowListDraft" className="text-sm font-medium">
                  Allowed destinations
                </label>
                <div className="flex gap-2">
                  <input
                    id="egressAllowListDraft"
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addDraft();
                      }
                    }}
                    placeholder="api.example.com"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                    aria-invalid={draftParse?.ok === false}
                  />
                  <button
                    type="button"
                    onClick={addDraft}
                    disabled={!draftParse || !draftParse.ok}
                    className="shrink-0 rounded-md border border-input px-3 py-2 text-sm disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
                {draftParse && !draftParse.ok && (
                  <p className="text-xs text-red-700 dark:text-red-300">{draftParse.error}</p>
                )}
                {entryErrors.length > 0 && (
                  <ul className="space-y-1">
                    {entryErrors.map((row) => (
                      <li
                        key={row.entry}
                        className="flex items-start justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-sm">{row.entry}</p>
                          {!row.parse.ok && (
                            <p className="text-xs text-red-700 dark:text-red-300">{row.parse.error}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setEntries((current) => current.filter((item) => item !== row.entry))}
                          className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {hasInvalidEntries && (
                  <p className="text-xs text-red-700 dark:text-red-300">
                    Remove invalid entries before saving.
                  </p>
                )}
              </div>
            )}

            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {EGRESS_ALLOW_LIST_HELP.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{EGRESS_PRIVATE_RANGES_HELP}</p>

            {showIsolationWarning && (
              <div className="space-y-2">
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                  {EGRESS_ALLOW_LIST_ISOLATION_WARNING}
                </div>
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                  {EGRESS_LAN_BLOCKING_NEEDS_BWRAP}
                </div>
              </div>
            )}
          </div>

          {hasOverrides && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" name="clearCodeExecutionOverrides" className="rounded border-input" />
              Clear per-agent overrides
            </label>
          )}
        </div>
      )}

      <ActionSubmitButton
        label="Save code & execution"
        disabled={mode === 'list' && hasInvalidEntries}
      />
    </form>
  );
}
