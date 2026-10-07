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
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
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
  resolveEgressSocketRoot,
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
  const workspace = new Workspace({
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
      const destroyCacheKey = companyId
        ? buildCacheKey(companyId, taskId, runtimeConfig, agentSecrets)
        : undefined;
      sandbox.destroy = async () => {
        try {
          await originalDestroy();
        } finally {
          // Stop the proxy (and unlink its unix socket) even if the sandbox's
          // own destroy() throws — stop() never rejects on a close error.
          if (proxy) {
            await proxy.stop();
          }
          // Drop the live-set entry so a later workspace teardown does not
          // double-destroy this sandbox.
          if (destroyCacheKey) {
            forgetLiveSandbox(workspace, destroyCacheKey);
          }
        }
      };

      // Register the resolver sandbox so workspace teardown can reach it:
      // Mastra's Workspace.destroy() would otherwise only drop the cache ref.
      const cacheKey = destroyCacheKey;
      if (cacheKey) {
        const state = workspaceTeardown.get(workspace);
        if (state && !state.destroying) {
          state.live.set(cacheKey, { sandbox, proxy });
        }
      }

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

  // Own the egress-proxy lifecycle that Mastra does not: a resolver-returned
  // sandbox is only ever dropped via clearSandboxCache() by Workspace.destroy
  // (WeakMap/Map refs), never destroyed — so nothing would stop its
  // EgressProxy or unlink its unix socket. Destroy all live resolver
  // sandboxes (stopping their proxies) *before* the cache clear and the
  // original destroy, and keep the operation idempotent (a durable wake and
  // its AgentController can both reach this workspace per wake).
  workspaceTeardown.set(workspace, { live: new Map() });
  const originalWorkspaceDestroy = workspace.destroy.bind(workspace);
  Object.defineProperty(workspace, '__tourbillonOriginalDestroy', {
    value: originalWorkspaceDestroy,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(workspace, '__tourbillonDestroyWrapped', {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  workspace.destroy = async () => {
    await teardownWorkspace(workspace);
  };

  return workspace;
}

/** Per-workspace registry of live resolver-returned sandboxes (see below). */
interface LiveSandboxEntry {
  sandbox: LocalSandbox;
  proxy?: EgressProxy;
}

interface WorkspaceTeardownState {
  live: Map<string, LiveSandboxEntry>;
  destroying?: Promise<void>;
}

const SWEEP_MAX_PER_ROOT = 100;

const teardownLogger = createTraceLogger('egress-teardown', {});

const workspaceTeardown = new WeakMap<Workspace, WorkspaceTeardownState>();

function forgetLiveSandbox(workspace: Workspace, cacheKey: string): void {
  workspaceTeardown.get(workspace)?.live.delete(cacheKey);
}

/**
 * Drain a workspace's live proxy-bound sandboxes: destroy each still-live
 * resolver sandbox (the patched destroy stops its EgressProxy and unlinks the
 * unix socket), then clear the Mastra sandbox cache, then run the original
 * (unpatched) workspace destroy so Mastra's own teardown still runs.
 *
 * Mastra's Workspace.destroy() only stops a *static* sandbox; sandboxes
 * returned from a resolver are dropped via clearSandboxCache() (Map refs
 * only), so their EgressProxy unix sockets would stay bound forever.
 *
 * Idempotent and never rejects — safe to call from a finally block.
 */
async function teardownWorkspace(workspace: Workspace): Promise<void> {
  const state = workspaceTeardown.get(workspace);
  if (!state) return;

  // Concurrent callers join the in-flight teardown instead of racing it.
  if (state.destroying) {
    await state.destroying;
    return;
  }

  const run = (async () => {
    const entries = [...state.live.values()];
    state.live.clear();
    for (const entry of entries) {
      try {
        await entry.sandbox.destroy();
      } catch (err) {
        teardownLogger.warn('sandbox destroy during workspace teardown failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Drop Mastra's cache refs before the original destroy so refs are gone
    // even if the original destroy() throws (its _performDestroy clears the
    // cache too, but only if it gets that far).
    try {
      workspace.clearSandboxCache();
    } catch (err) {
      teardownLogger.warn('clearSandboxCache during workspace teardown failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      const original = (workspace as unknown as {
        __tourbillonOriginalDestroy?: () => Promise<void>;
      }).__tourbillonOriginalDestroy;
      if (original) await original();
    } catch (err) {
      teardownLogger.warn('original workspace destroy() failed after sandbox teardown', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  state.destroying = run;
  await run;
}

/**
 * Public helper (Part C): destroy a workspace whose resolver may have returned
 * proxy-bound sandboxes. Pass the workspace from `agent.getWorkspace()` or
 * `controller.getWorkspace()` in a wake-teardown finally block.
 */
export async function destroyCodeExecutionWorkspace(
  workspaceOrSandbox?: unknown,
): Promise<void> {
  if (!workspaceOrSandbox) return;

  const target = workspaceOrSandbox as {
    __tourbillonDestroyWrapped?: boolean;
    destroy?: () => Promise<void>;
    clearSandboxCache?: () => void;
    hasSandboxConfig?: () => boolean;
    sandbox?: unknown;
    provider?: string;
    name?: string;
  };

  // Hardened wrapper installed (buildCodeExecutionWorkspace or an earlier
  // call): call through to it — the wrapper's destroy() drains the live set.
  if (target.__tourbillonDestroyWrapped && typeof target.destroy === 'function') {
    await target.destroy!();
    return;
  }

  // Raw sandbox instance (no Workspace wrapper): call its own destroy(),
  // which the patched sandbox destroy routes to proxy.stop().
  const looksLikeSandbox =
    typeof target.destroy === 'function' &&
    typeof target.provider === 'string' &&
    typeof target.name === 'string';
  if (looksLikeSandbox) {
    try {
      await target.destroy!();
    } catch (err) {
      teardownLogger.warn('raw sandbox destroy() failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Foreign workspace (e.g. a chat workspace, or an unhardened code-execution
  // Workspace): nothing tracked here — preserve Mastra semantics by invoking
  // its own destroy(). Duck-typed so neither shape can throw.
  //
  // A Workspace whose `sandbox` is a *resolver function* never destroys that
  // sandbox in its own destroy(); drain the tracked {sandbox, proxy} pairs
  // first so the EgressProxy socket is unlinked even on this unhardened path
  // (per-agent workspace and per-run session workspace can be distinct).
  const foreignState = workspaceTeardown.get(workspaceOrSandbox as Workspace);
  if (foreignState && foreignState.live.size > 0) {
    const entries = [...foreignState.live.values()];
    foreignState.live.clear();
    for (const entry of entries) {
      try {
        await entry.sandbox.destroy();
      } catch (err) {
        teardownLogger.warn('foreign workspace sandbox destroy failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const resolverSandbox =
    typeof target.sandbox === 'function'
      ? (target.sandbox as (
          options?: unknown,
        ) => { destroy?: () => Promise<void> } | Promise<{ destroy?: () => Promise<void> }>)
      : undefined;
  try {
    target.clearSandboxCache?.();
  } catch {
    /* best effort */
  }
  try {
    await target.destroy?.();
  } catch (err) {
    teardownLogger.warn('foreign workspace destroy() failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Workspace.destroy() only stops a *static* sandbox (callLifecycle on
  // _sandbox); a *resolver* `sandbox` function would otherwise never be
  // resolved at teardown, so its EgressProxy socket would stay bound. Resolve
  // the factory ourselves (workspace destroy() already cleared the cache, so
  // this builds a fresh sandbox — cheap: the proxy is created in the
  // sandbox's own constructor) and stop its proxy.
  if (resolverSandbox) {
    try {
      const sandbox = await resolverSandbox({
        requestContext: new RequestContext(),
      });
      if (sandbox && typeof sandbox.destroy === 'function') {
        await sandbox.destroy();
      }
    } catch (err) {
      teardownLogger.warn('resolver sandbox destroy after foreign workspace destroy failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Defence-in-depth (NOT the primary fix): unlink dead `.sock` files left under
 * the egress socket roots. Connect-probe each socket; bound sockets (an
 * in-flight wake) are always skipped. At boot nothing else writes into the
 * socket roots, so no fresh proxy socket can be deleted.
 */
export async function sweepStaleEgressSockets(): Promise<number> {
  const roots = new Set<string>();
  try {
    roots.add(resolveEgressSocketRoot());
  } catch {
    /* no usable socket root */
  }
  const override = process.env.TOURBILLON_EGRESS_SOCKET_ROOT;
  if (override) roots.add(override);

  let removed = 0;
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (removed >= SWEEP_MAX_PER_ROOT) break;
      if (!name.endsWith('.sock')) continue;
      const full = join(root, name);
      try {
        if (!statSync(full).isSocket()) continue;
      } catch {
        continue;
      }
      const dead = await new Promise<boolean>((resolve) => {
        const sock = createConnection({ path: full }, () => {
          sock.destroy();
          resolve(false); // live listener — never unlink
        });
        sock.once('error', () => {
          sock.destroy();
          resolve(true); // nothing accepting on this socket
        });
      });
      if (!dead) continue;
      try {
        unlinkSync(full);
        removed += 1;
      } catch {
        /* raced with another owner */
      }
    }
  }

  if (removed > 0) {
    teardownLogger.info('swept stale egress proxy sockets', { removed });
  }
  return removed;
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
