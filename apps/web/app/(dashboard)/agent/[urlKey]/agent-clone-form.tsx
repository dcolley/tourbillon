'use client';

import { ActionForm, ActionSubmitButton } from '@/components/action-form';
import type { ActionResult } from '@/lib/action-result';

export function AgentCloneForm({
  sourceAgentId,
  defaultName,
  defaultUrlKey,
  cloneAgentAction,
}: {
  sourceAgentId: string;
  defaultName: string;
  defaultUrlKey: string;
  cloneAgentAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}) {
  return (
    <section className="border rounded-lg p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Clone agent</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Create a new agent with the same role, model, skills, toolsets, instructions, and MCP
          settings. Automatic heartbeats start disabled. Knowledge-graph memory is not copied.
        </p>
      </div>
      <ActionForm action={cloneAgentAction} className="space-y-4">
        <input type="hidden" name="sourceAgentId" value={sourceAgentId} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="clone-name" className="text-sm font-medium">
              Name
            </label>
            <input
              id="clone-name"
              name="name"
              type="text"
              required
              defaultValue={defaultName}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="clone-url-key" className="text-sm font-medium">
              Agent ID
            </label>
            <input
              id="clone-url-key"
              name="urlKey"
              type="text"
              required
              defaultValue={defaultUrlKey}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Must be unique in this company. Opens <span className="font-mono">/agent/…</span> after
              save.
            </p>
          </div>
        </div>
        <label className="flex items-start gap-2 cursor-pointer text-sm">
          <input
            type="checkbox"
            name="copyCredentials"
            defaultChecked
            className="mt-0.5 rounded border-input"
          />
          <span>
            <span className="font-medium">Copy agent-level credentials</span>
            <span className="block text-xs text-muted-foreground">
              Includes Buffer / Tavily / SearXNG overrides and MCP API keys stored on this agent.
              Company and env fallbacks still apply if unchecked.
            </span>
          </span>
        </label>
        <ActionSubmitButton label="Clone as new agent" pendingLabel="Cloning…" />
      </ActionForm>
    </section>
  );
}
