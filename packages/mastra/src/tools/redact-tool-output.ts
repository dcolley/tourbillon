import { redactAgentSecretsDeep } from '@tourbillon/shared';

type ExecutableTool = { execute?: (...args: unknown[]) => unknown };

const WRAPPED = Symbol.for('tourbillon.agentSecretRedaction');

/**
 * #100: Single choke point for agent-facing tool output. Every tool handed to an agent
 * (control-plane, role/roster, assignable, MCP, skill, discovery tools) goes through
 * assembleAgentTools → here, so any result carrying an agent `runtimeConfig` returns
 * secret key names only (`{ KEY: '[redacted]' }`) and never values. A new read tool
 * cannot skip this. Tools are cloned, never mutated (module-level tool singletons are shared).
 */
export function withAgentSecretRedaction<T extends Record<string, unknown>>(tools: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = wrapTool(tool);
  }
  return out as T;
}

function wrapTool(tool: unknown): unknown {
  if (!tool || typeof tool !== 'object') return tool;
  const t = tool as ExecutableTool & { [WRAPPED]?: true };
  if (typeof t.execute !== 'function' || t[WRAPPED]) return tool;

  const original = t.execute;
  const clone = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool) as ExecutableTool & {
    [WRAPPED]?: true;
  };
  clone.execute = async function redactedExecute(this: unknown, ...args: unknown[]) {
    const result = await original.apply(this ?? tool, args);
    return redactAgentSecretsDeep(result);
  };
  Object.defineProperty(clone, WRAPPED, { value: true, enumerable: false });
  return clone;
}
