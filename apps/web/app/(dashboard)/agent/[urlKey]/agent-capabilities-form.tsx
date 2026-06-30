'use client';

import { useRef } from 'react';
import { GRANULAR_TOOL_GROUPS, type ToolCapability } from '@tourbillon/shared/tool-catalog';
import { TOOLSET_CATALOG } from '@tourbillon/shared/constants';

interface AgentCapabilitiesFormProps {
  agentId: string;
  urlKey: string;
  assignedToolsets: string[];
  enabledTools: string[];
  bufferApiKeyOverride?: string;
  searxngUrlOverride?: string;
  updateCapabilities: (formData: FormData) => Promise<void>;
}

export function AgentCapabilitiesForm({
  agentId,
  urlKey,
  assignedToolsets,
  enabledTools,
  bufferApiKeyOverride,
  searxngUrlOverride,
  updateCapabilities,
}: AgentCapabilitiesFormProps) {
  const formRef = useRef<HTMLFormElement>(null);

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

  return (
    <form ref={formRef} action={updateCapabilities} className="space-y-6 border-t pt-4">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="urlKey" value={urlKey} />

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
          {TOOLSET_CATALOG.map((entry) => {
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

      {(assignedToolsets.includes('buffer') || assignedToolsets.includes('web-search')) && (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">Integration overrides</p>
          <p className="text-xs text-muted-foreground">
            Optional per-agent values. Leave blank to use company settings or environment fallbacks.
          </p>

          {assignedToolsets.includes('buffer') && (
            <div className="space-y-2">
              <label htmlFor="bufferApiKey" className="text-sm font-medium">
                Buffer API key override
              </label>
              <input
                id="bufferApiKey"
                name="bufferApiKey"
                type="password"
                placeholder={bufferApiKeyOverride ? '••••••••' : 'Uses company or BUFFER_API_KEY'}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              {bufferApiKeyOverride && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" name="clearBufferApiKey" className="rounded border-input" />
                  Clear agent override
                </label>
              )}
            </div>
          )}

          {assignedToolsets.includes('web-search') && (
            <div className="space-y-2">
              <label htmlFor="searxngUrl" className="text-sm font-medium">
                SearXNG base URL override
              </label>
              <input
                id="searxngUrl"
                name="searxngUrl"
                type="url"
                defaultValue={searxngUrlOverride ?? ''}
                placeholder="http://localhost:8888"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              />
              {searxngUrlOverride && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" name="clearSearxngUrl" className="rounded border-input" />
                  Clear agent override
                </label>
              )}
            </div>
          )}
        </div>
      )}

      <button
        type="submit"
        className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
      >
        Save capabilities
      </button>
    </form>
  );
}
