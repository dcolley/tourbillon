import {
  Workspace,
  LocalSandbox,
  LocalFilesystem,
  type IsolationBackend,
} from '@mastra/core/workspace';
import {
  ensureExecutionWorkspace,
  resolveSandboxIsolation,
  resolveSandboxTimeoutMs,
  resolveSandboxAllowNetwork,
  type AgentRuntimeConfig,
} from '@tourbillon/shared';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function readCodeExecutionConfig(requestContext: {
  get: (key: string) => unknown;
}): AgentRuntimeConfig | null {
  const value = requestContext.get('agentRuntimeConfig');
  if (!value || typeof value !== 'object') return null;
  return value as AgentRuntimeConfig;
}

/**
 * Extract agent secrets from request context for code execution sandbox (AC-B1.2).
 * Returns sanitized environment variables from agent's runtimeConfig.secrets.
 */
function extractAgentSecrets(requestContext: {
  get: (key: string) => unknown;
}): Record<string, string> {
  const runtimeConfig = readCodeExecutionConfig(requestContext);
  const secrets = runtimeConfig?.secrets;
  
  if (!secrets || typeof secrets !== 'object') {
    return {};
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof key === 'string' && typeof value === 'string' && key.trim() && value.trim()) {
      // Only inject well-formed key=value pairs
      env[key.trim()] = value;
    }
  }
  
  return env;
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
      const isolation = resolveSandboxIsolation(runtimeConfig) as IsolationBackend;
      const allowNetwork = resolveSandboxAllowNetwork(runtimeConfig);
      
      // AC-B1.2: Inject agent secrets as environment variables into sandbox
      const agentSecrets = extractAgentSecrets(requestContext);
      
      return new LocalSandbox({
        workingDirectory: cwd,
        isolation,
        timeout: resolveSandboxTimeoutMs(runtimeConfig),
        nativeSandbox: isolation !== 'none' ? { allowNetwork } : undefined,
        // Inject secrets as environment variables
        env: Object.keys(agentSecrets).length > 0 ? (agentSecrets as unknown as NodeJS.ProcessEnv) : undefined,
      });
    },
    sandboxCacheKey: ({ requestContext }) => {
      const companyId = requestContext.get('companyId') as string | undefined;
      const taskId = requestContext.get('taskId') as string | undefined;
      const runtimeConfig = readCodeExecutionConfig(requestContext);
      const isolation = resolveSandboxIsolation(runtimeConfig);
      const timeoutMs = resolveSandboxTimeoutMs(runtimeConfig);
      const allowNetwork = resolveSandboxAllowNetwork(runtimeConfig);
      // Include secrets hash in cache key so different secrets trigger sandbox recreation
      const agentSecrets = extractAgentSecrets(requestContext);
      const secretsHash = Object.keys(agentSecrets).sort().join(',');
      return companyId
        ? `${companyId}:${taskId ?? 'idle'}:${isolation}:${timeoutMs}:${allowNetwork}:${secretsHash}`
        : undefined;
    },
  });
}

/**
 * Minimal workspace so AgentController Session can construct (Mastra requires
 * `workspace instanceof Workspace`) without injecting sandbox tool schemas into
 * the chat context window.
 */
export function buildChatWorkspace(): Workspace {
  const basePath = join(tmpdir(), 'tourbillon-chat-workspace');
  mkdirSync(basePath, { recursive: true });
  return new Workspace({
    id: 'tourbillon-chat',
    name: 'Chat',
    filesystem: new LocalFilesystem({ basePath }),
    tools: { enabled: false },
  });
}
