import { TOOL_EGRESS_ALLOW_LIST_HELP } from '@tourbillon/shared';

/**
 * Form fields for an outbound host allow-list for agent tools (company or agent level).
 * Posts `toolEgressMode` ('off' | 'list') and `toolEgressEntries` (one host per line).
 */
export function ToolEgressAllowListFields({
  list,
  scope,
}: {
  /** Stored list; undefined = off (every host allowed). */
  list: string[] | undefined;
  scope: 'company' | 'agent';
}) {
  const on = list !== undefined;
  const offLabel =
    scope === 'company' ? 'Allow every host (default)' : 'No agent-level list (company list applies)';
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1.5">
        <label className="flex items-center gap-2">
          <input type="radio" name="toolEgressMode" value="off" defaultChecked={!on} />
          <span>{offLabel}</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="toolEgressMode" value="list" defaultChecked={on} />
          <span>Only these hosts</span>
        </label>
      </div>
      <textarea
        name="toolEgressEntries"
        aria-label="Allowed hosts, one per line"
        rows={4}
        defaultValue={(list ?? []).join('\n')}
        placeholder={'search.example.com\n*.example.org\nmcp.example.net:443'}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
      />
      <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
        {TOOL_EGRESS_ALLOW_LIST_HELP.map((line) => (
          <li key={line}>{line}</li>
        ))}
        <li>
          Applies to web search (SearXNG, Tavily), Nitter and HTTP MCP servers. An empty list with
          &quot;Only these hosts&quot; allows no outbound host.
        </li>
        {scope === 'agent' && <li>A host must also be allowed by the company list, when one is set.</li>}
      </ul>
    </div>
  );
}
