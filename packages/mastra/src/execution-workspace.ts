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
import { createHash } from 'node:crypto';

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

/**
 * AC-B1.3 fix: Hash secret values (not just keys) for sandboxCacheKey.
 * Rotating password values must recreate LocalSandbox with fresh env.
 * 
 * Returns SHA-256 hash of stable-sorted key=value pairs.
 * Never logs plaintext secrets or raw hash inputs.
 */
function hashSecretValues(secrets: Record<string, string>): string {
  if (Object.keys(secrets).length === 0) {
    return '';
  }
  
  // Stable sort: alphabetical by key, then hash "key=value\n" lines
  const sortedKeys = Object.keys(secrets).sort();
  const lines = sortedKeys.map((k) => `${k}=${secrets[k]}`);
  const input = lines.join('\n');
  
  // SHA-256 fingerprint (hex digest)
  const hash = createHash('sha256').update(input, 'utf8').digest('hex');
  
  // Return first 16 chars (sufficient for cache key uniqueness)
  return hash.substring(0, 16);
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
      
      // AC-B1.3 fix: Hash secret VALUES (not just keys) for cache invalidation.
      // Rotating password values must trigger sandbox recreation with fresh env.
      const agentSecrets = extractAgentSecrets(requestContext);
      const secretsFingerprint = hashSecretValues(agentSecrets);
      
      return companyId
        ? `${companyId}:${taskId ?? 'idle'}:${isolation}:${timeoutMs}:${allowNetwork}:${secretsFingerprint}`
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
