'use client';

import { useActionState, useState } from 'react';
import type { AgentRuntimeType, SandboxIsolation } from '@tourbillon/shared';
import type { CodeExecutionAvailability } from '@tourbillon/shared';
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
  updateCodeExecution,
}: AgentCodeExecutionFormProps) {
  const [state, formAction] = useActionState(updateCodeExecution, null);
  useActionToast(state);
  const [enabled, setEnabled] = useState(codeExecutionEnabled);

  return (
    <form action={formAction} className="space-y-4 border-t pt-4">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="urlKey" value={urlKey} />

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
              defaultValue={isolationOverride ?? ''}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Use environment default ({availability.isolation})</option>
              <option value="none">none</option>
              <option value="seatbelt">seatbelt (macOS)</option>
              <option value="bwrap">bwrap (Linux)</option>
            </select>
          </div>
          {(timeoutOverride !== undefined || isolationOverride !== undefined) && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" name="clearCodeExecutionOverrides" className="rounded border-input" />
              Clear per-agent overrides
            </label>
          )}
        </div>
      )}

      <ActionSubmitButton label="Save code & execution" />
    </form>
  );
}
