import {
  Workspace,
  LocalSandbox,
  LocalFilesystem,
  type IsolationBackend,
} from '@mastra/core/workspace';
import {
  createTraceLogger,
  ensureExecutionWorkspace,
  resolveSandboxIsolation,
  resolveSandboxTimeoutMs,
  resolveSandboxAllowNetwork,
  resolveSandboxEgressAllowList,
  type AgentRuntimeConfig,
} from '@tourbillon/shared';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { EgressProxy } from './egress-proxy';
import {
  assertCanEnforceEgressAllowList,
  buildEgressFilterEnv,
  buildTourbillonBwrapArgs,
  egressProxySocketPath,
  resolveEgressBwrapBinds,
} from './egress-enforcement';

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
      env[key.trim()] = value;
    }
  }
  
  return env;
}

/**
 * AC-B1.3 fix: Hash secret values (not just keys) for sandboxCacheKey.
 * Rotating password values must recreate LocalSandbox with fresh env.
 */
function hashSecretValues(secrets: Record<string, string>): string {
  if (Object.keys(secrets).length === 0) {
    return '';
  }
  
  const sortedKeys = Object.keys(secrets).sort();
  const lines = sortedKeys.map((k) => `${k}=${secrets[k]}`);
  const input = lines.join('\n');
  const hash = createHash('sha256').update(input, 'utf8').digest('hex');
  return hash.substring(0, 16);
}

function buildCacheKey(
  companyId: string,
  taskId: string | undefined,
  runtimeConfig: AgentRuntimeConfig | null,
  agentSecrets: Record<string, string>,
): string {
  const isolation = resolveSandboxIsolation(runtimeConfig);
  const timeoutMs = resolveSandboxTimeoutMs(runtimeConfig);
  const allowNetwork = resolveSandboxAllowNetwork(runtimeConfig);
  const egressAllowList = resolveSandboxEgressAllowList(runtimeConfig);
  const secretsFingerprint = hashSecretValues(agentSecrets);
  const egressKey = egressAllowList !== undefined 
    ? egressAllowList.slice().sort().join(',')
    : 'legacy';
  return `${companyId}:${taskId ?? 'idle'}:${isolation}:${timeoutMs}:${allowNetwork}:${egressKey}:${secretsFingerprint}`;
}

/** Socket path the code-execution factory binds for a non-empty allow-list. */
export function resolveCodeExecutionProxySocketPath(
  companyId: string,
  taskId: string | undefined,
  allowList: string[],
  options?: { socketRoot?: string; runId?: string },
): string {
  return egressProxySocketPath(companyId, taskId, allowList, options);
}

export function newEgressRunId(): string {
  return randomBytes(16).toString('hex');
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
      const egressAllowList = resolveSandboxEgressAllowList(runtimeConfig);

      assertCanEnforceEgressAllowList(isolation, egressAllowList);

      const allowNetwork = resolveSandboxAllowNetwork(runtimeConfig);
      const agentSecrets = extractAgentSecrets(requestContext);

      let sandboxEnv: NodeJS.ProcessEnv = { ...agentSecrets };
      let proxy: EgressProxy | undefined;
      let extraRoBinds: string[] = [];
      let extraRwBinds: string[] = [];

      if (egressAllowList !== undefined) {
        if (egressAllowList.length > 0) {
          const runId = newEgressRunId();
          const socketPath = resolveCodeExecutionProxySocketPath(
            companyId,
            taskId,
            egressAllowList,
            { runId },
          );
          proxy = new EgressProxy({ allowList: egressAllowList, companyId, taskId });
          await proxy.start({ socketPath });
          if (!proxy.getSocketPath()) {
            throw new Error('Egress proxy did not bind a unix socket');
          }
          sandboxEnv = buildEgressFilterEnv({
            proxySocketPath: socketPath,
            extra: sandboxEnv,
          });
          const binds = resolveEgressBwrapBinds({ proxySocketPath: socketPath });
          extraRoBinds = binds.extraRoBinds;
          extraRwBinds = binds.extraRwBinds;
        } else {
          try {
            sandboxEnv = buildEgressFilterEnv({ extra: sandboxEnv });
            const binds = resolveEgressBwrapBinds({});
            extraRoBinds = binds.extraRoBinds;
            extraRwBinds = binds.extraRwBinds;
          } catch (err) {
            if (isolation === 'none') throw err;
            const message = err instanceof Error ? err.message : String(err);
            createTraceLogger('egress', { companyId, taskId }).warn(
              'Egress filter unavailable; continuing with OS network isolation only',
              { error: message },
            );
          }
        }
      }

      const nativeSandbox = isolation === 'none'
        ? undefined
        : isolation === 'bwrap'
          ? {
              allowNetwork,
              bwrapArgs: buildTourbillonBwrapArgs({
                workspacePath: cwd,
                allowNetwork,
                extraRoBinds,
                extraRwBinds,
              }),
            }
          : { allowNetwork };

      const sandbox = new LocalSandbox({
        workingDirectory: cwd,
        isolation,
        timeout: resolveSandboxTimeoutMs(runtimeConfig),
        nativeSandbox,
        env: Object.keys(sandboxEnv).length > 0 ? sandboxEnv : undefined,
      });

      const originalDestroy = sandbox.destroy.bind(sandbox);
      sandbox.destroy = async () => {
        await originalDestroy();
        if (proxy) {
          await proxy.stop();
        }
      };

      return sandbox;
    },
    sandboxCacheKey: ({ requestContext }) => {
      const companyId = requestContext.get('companyId') as string | undefined;
      const taskId = requestContext.get('taskId') as string | undefined;
      const runtimeConfig = readCodeExecutionConfig(requestContext);
      const agentSecrets = extractAgentSecrets(requestContext);
      return companyId ? buildCacheKey(companyId, taskId, runtimeConfig, agentSecrets) : undefined;
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
