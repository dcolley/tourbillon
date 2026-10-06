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
  type SandboxIsolation,
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

/** Socket-path hash sentinel for legacy allowNetwork:true public-internet mode. */
export const PUBLIC_INTERNET_EGRESS_SENTINEL = '*public-internet*';

export type CodeExecutionEgressPlan =
  | { kind: 'none' }
  | { kind: 'deny-filter' }
  | { kind: 'allow-list'; allowList: string[] }
  | { kind: 'public-internet' }
  | { kind: 'unenforceable-legacy'; isolation: 'none' | 'seatbelt' };

/**
 * How a sandbox run should attach network: OS share, unix-socket proxy,
 * public-internet proxy, or deny. isolation=none/seatbelt cannot enforce
 * the proxy; a non-empty list is still refused by assertCanEnforceEgressAllowList.
 */
export function planCodeExecutionEgress(
  isolation: SandboxIsolation,
  runtimeConfig: AgentRuntimeConfig | null,
): CodeExecutionEgressPlan {
  const list = resolveSandboxEgressAllowList(runtimeConfig);
  if (list !== undefined) {
    return list.length === 0 ? { kind: 'deny-filter' } : { kind: 'allow-list', allowList: list };
  }
  if (resolveSandboxAllowNetwork(runtimeConfig)) {
    if (isolation === 'bwrap') return { kind: 'public-internet' };
    return { kind: 'unenforceable-legacy', isolation };
  }
  return { kind: 'none' };
}

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
      const egressPlan = planCodeExecutionEgress(isolation, runtimeConfig);
      const agentSecrets = extractAgentSecrets(requestContext);

      let sandboxEnv: NodeJS.ProcessEnv = { ...agentSecrets } as NodeJS.ProcessEnv;
      let proxy: EgressProxy | undefined;
      let extraRoBinds: string[] = [];
      let extraRwBinds: string[] = [];

      const startProxy = async (allowList: string[], publicInternet: boolean) => {
        const runId = newEgressRunId();
        const socketPath = resolveCodeExecutionProxySocketPath(
          companyId,
          taskId,
          publicInternet ? [PUBLIC_INTERNET_EGRESS_SENTINEL] : allowList,
          { runId },
        );
        proxy = new EgressProxy({
          allowList,
          companyId,
          taskId,
          publicInternet,
        });
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
      };

      if (egressPlan.kind === 'allow-list') {
        await startProxy(egressPlan.allowList, false);
      } else if (egressPlan.kind === 'public-internet') {
        await startProxy([], true);
      } else if (egressPlan.kind === 'deny-filter') {
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
      } else if (egressPlan.kind === 'unenforceable-legacy') {
        createTraceLogger('egress', { companyId, taskId }).warn(
          'Legacy allowNetwork=true cannot enforce LAN blocking without isolation=bwrap; private ranges remain reachable',
          { isolation: egressPlan.isolation },
        );
      }

      const osNetworkShare = egressPlan.kind === 'unenforceable-legacy' ? allowNetwork : false;

      const nativeSandbox = isolation === 'none'
        ? undefined
        : isolation === 'bwrap'
          ? {
              allowNetwork: osNetworkShare,
              bwrapArgs: buildTourbillonBwrapArgs({
                workspacePath: cwd,
                allowNetwork: osNetworkShare,
                extraRoBinds,
                extraRwBinds,
              }),
            }
          : { allowNetwork: osNetworkShare };

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
