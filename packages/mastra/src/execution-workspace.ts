import {
  Workspace,
  LocalSandbox,
  type IsolationBackend,
} from '@mastra/core/workspace';
import {
  ensureExecutionWorkspace,
  resolveSandboxIsolation,
  resolveSandboxTimeoutMs,
  type AgentRuntimeConfig,
} from '@tourbillon/shared';

function readCodeExecutionConfig(requestContext: {
  get: (key: string) => unknown;
}): AgentRuntimeConfig | null {
  const value = requestContext.get('codeExecutionConfig');
  if (!value || typeof value !== 'object') return null;
  return value as AgentRuntimeConfig;
}

export function buildCodeExecutionWorkspace(): Workspace {
  return new Workspace({
    id: 'tourbillon-code-execution',
    name: 'Code execution',
    sandbox: async ({ requestContext }) => {
      const companyId = requestContext.get('companyId') as string | undefined;
      if (!companyId) {
        throw new Error('companyId not present in request context for code execution sandbox');
      }
      const taskId = requestContext.get('taskId') as string | undefined;
      const runtimeConfig = readCodeExecutionConfig(requestContext);
      const cwd = await ensureExecutionWorkspace(companyId, taskId);
      return new LocalSandbox({
        workingDirectory: cwd,
        isolation: resolveSandboxIsolation(runtimeConfig) as IsolationBackend,
        timeout: resolveSandboxTimeoutMs(runtimeConfig),
      });
    },
    sandboxCacheKey: ({ requestContext }) => {
      const companyId = requestContext.get('companyId') as string | undefined;
      const taskId = requestContext.get('taskId') as string | undefined;
      const runtimeConfig = readCodeExecutionConfig(requestContext);
      const isolation = resolveSandboxIsolation(runtimeConfig);
      const timeoutMs = resolveSandboxTimeoutMs(runtimeConfig);
      return companyId
        ? `${companyId}:${taskId ?? 'idle'}:${isolation}:${timeoutMs}`
        : undefined;
    },
  });
}
