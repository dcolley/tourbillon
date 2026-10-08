import { redactAgentSecretsDeep } from '@tourbillon/shared';
import { checkToolPermission, toolNotAllowedResult, type ToolGateContext } from '../tool-gate';

type ExecutableTool = { id?: unknown; execute?: (...args: unknown[]) => unknown };

const WRAPPED = Symbol.for('tourbillon.agentSecretRedaction');

/**
 * #100: Single choke point for agent-facing tool output. Every tool handed to an agent
 * (control-plane, role/roster, assignable, MCP, skill, discovery tools) goes through
 * assembleAgentTools → here, so any result carrying an agent `runtimeConfig` returns
 * secret key names only (`{ KEY: '[redacted]' }`) and never values. A new read tool
 * cannot skip this. Tools are cloned, never mutated (module-level tool singletons are shared).
 *
 * With a gate context, each tool also runs the live tool permission check before `execute`,
 * bound to the agent the tools were assembled for: the call must carry that agent's request
 * context and the tool must still be on its allow-list. Pass `null` only for tool sets that
 * are never handed to an agent.
 */
export function withAgentSecretRedaction<T extends Record<string, unknown>>(
  tools: T,
  gate: ToolGateContext | null,
): T {
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = wrapTool(name, tool, gate);
  }
  return out as T;
}

function wrapTool(name: string, tool: unknown, gate: ToolGateContext | null): unknown {
  if (!tool || typeof tool !== 'object') return tool;
  const t = tool as ExecutableTool & { [WRAPPED]?: true };
  if (typeof t.execute !== 'function' || t[WRAPPED]) return tool;

  const original = t.execute;
  const toolId = typeof t.id === 'string' ? t.id : undefined;
  const clone = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool) as ExecutableTool & {
    [WRAPPED]?: true;
  };
  clone.execute = async function redactedExecute(this: unknown, ...args: unknown[]) {
    if (gate) {
      const context = args[1] as { requestContext?: unknown } | undefined;
      const decision = await checkToolPermission({
        ...gate,
        toolName: name,
        toolId,
        requestContext: context?.requestContext,
      });
      if (!decision.allowed) return toolNotAllowedResult(name, decision.reason);
    }
    const result = await original.apply(this ?? tool, args);
    return redactAgentSecretsDeep(result);
  };
  Object.defineProperty(clone, WRAPPED, { value: true, enumerable: false });
  return clone;
}
