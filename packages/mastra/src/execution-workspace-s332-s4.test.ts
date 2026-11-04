/**
 * S332-S4 pin (gate #332 soft): the resolver's LocalSandbox-ctor-throw catch must stop the
 * already-bound egress proxy.
 *
 * Mastra 1.81 throws `IsolationUnavailableError` from the `LocalSandbox` constructor AFTER
 * the resolver started the EgressProxy (execution-workspace.ts). The catch there calls
 * `proxy.stop()` — without it the unix socket keeps the process alive (gate mutant W1 hung
 * the CI runner). That path was only reachable on x86_64 CI: on arm64/Spark1,
 * `assertCanEnforceEgressAllowList` refuses BEFORE the proxy binds, so the existing destroy
 * test skips its sock assertion there and W1 was natively GREEN — the fix was unpinned on
 * the very hardware the fleet runs on.
 *
 * These pins use the S332-S4 seams (execution-workspace.ts `CodeExecutionWorkspaceSeams`)
 * to replay the exact CI interleaving deterministically on any host: enforce stubbed as
 * available, a fake proxy that records start/stop, and a LocalSandbox ctor that throws
 * IsolationUnavailableError. Mutation-verified: deleting `await proxy.stop()` from the
 * catch flips the stop assertion RED (and would hang a real run — the fake proxy proves
 * the call, so the suite cannot hang).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { IsolationUnavailableError } from '@mastra/core/workspace';
import { RequestContext } from '@mastra/core/request-context';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import {
  buildCodeExecutionWorkspace,
  type CodeExecutionProxyHandle,
  type CodeExecutionWorkspaceSeams,
} from './execution-workspace';

class FakeProxy implements CodeExecutionProxyHandle {
  static instances: FakeProxy[] = [];
  events: string[] = [];
  socketPath?: string;

  constructor(public readonly options: unknown) {
    FakeProxy.instances.push(this);
  }

  async start(listen: { socketPath: string } | { tcp: true }): Promise<number> {
    if (!('socketPath' in listen)) throw new Error('allow-list runs bind a unix socket');
    this.socketPath = listen.socketPath;
    this.events.push('start');
    return 17999;
  }

  async stop(): Promise<void> {
    this.events.push('stop');
  }

  getSocketPath(): string | undefined {
    return this.socketPath;
  }
}

function resolverArgs() {
  const requestContext = new RequestContext();
  requestContext.set('companyId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  requestContext.set('taskId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  requestContext.set('agentRuntimeConfig', {
    heartbeat: {
      enabled: false,
      intervalSec: 3600,
      wakeOnAssignment: false,
      wakeOnDemand: false,
      wakeOnAutomation: false,
    },
    timeout: { heartbeatSec: 300, graceSec: 30 },
    codeExecution: {
      isolation: 'bwrap',
      allowNetwork: false,
      egressAllowList: ['example.com'],
    },
  } satisfies AgentRuntimeConfig);
  return { requestContext };
}

describe('S332-S4: ctor-throw after proxy bind stops the proxy (deterministic on any host)', () => {
  const prevRoot = process.env.TOURBILLON_EGRESS_SOCKET_ROOT;

  it('LocalSandbox ctor throw => resolver rejects AND the bound proxy was stopped', async () => {
    process.env.TOURBILLON_EGRESS_SOCKET_ROOT = mkdtempSync(join(tmpdir(), 'tourbillon-s332-s4-'));
    FakeProxy.instances = [];
    let enforceCalls = 0;

    const seams: CodeExecutionWorkspaceSeams = {
      // Simulate the CI host: enforcement available (arm64 would refuse here, before bind).
      assertCanEnforceEgress: () => {
        enforceCalls += 1;
      },
      EgressProxyCtor: FakeProxy,
      LocalSandboxCtor: class {
        constructor(_options: unknown) {
          throw new IsolationUnavailableError('bwrap', 'not installed (S332-S4 simulated CI host)');
        }
      } as never,
    };

    try {
      const workspace = buildCodeExecutionWorkspace(seams);
      await assert.rejects(
        () =>
          (workspace as unknown as {
            resolveSandbox: (args: { requestContext: unknown }) => Promise<unknown>;
          }).resolveSandbox(resolverArgs()),
        (err: unknown) => err instanceof IsolationUnavailableError,
        'the IsolationUnavailableError must propagate unchanged from the catch',
      );

      assert.equal(enforceCalls, 1, 'the (seamed) enforce pre-check must have run once');
      assert.equal(FakeProxy.instances.length, 1, 'resolver must have constructed exactly one proxy');
      const proxy = FakeProxy.instances[0];
      assert.deepEqual(
        proxy.events,
        ['start', 'stop'],
        'the ctor-throw catch must stop() the proxy AFTER start() (gate mutant W1: removing ' +
          'await proxy.stop() in the catch leaves [start] and hangs a real run)',
      );
      assert.ok(proxy.socketPath, 'proxy must have bound a socket path before the throw');
    } finally {
      if (prevRoot === undefined) delete process.env.TOURBILLON_EGRESS_SOCKET_ROOT;
      else process.env.TOURBILLON_EGRESS_SOCKET_ROOT = prevRoot;
    }
  });

  it('structural: seams default to the production classes/functions (no behavioural drift)', () => {
    // An executable belt is impossible on this fleet: with a non-empty allow-list and bwrap
    // installed (true on Spark1), the un-seamed resolver SUCCEEDS and binds a real proxy —
    // resolving it here would leak a live unix socket into the suite. Instead pin, at the
    // source, that every seam falls back to the production implementation, so no future
    // edit can quietly default a seam to a stub: production call sites build WITHOUT seams
    // (agent-factory.ts / controller-config.ts) and must keep hitting the real classes.
    const src = readFileSync(join(__dirname, 'execution-workspace.ts'), 'utf8');
    assert.match(
      src,
      /seams\.LocalSandboxCtor\s*\?\?\s*LocalSandbox\b/,
      'LocalSandboxCtor must default to the real Mastra LocalSandbox',
    );
    assert.match(
      src,
      /seams\.EgressProxyCtor\s*\?\?\s*EgressProxy\b/,
      'EgressProxyCtor must default to the real EgressProxy',
    );
    assert.match(
      src,
      /seams\.assertCanEnforceEgress\s*\?\?\s*assertCanEnforceEgressAllowList\b/,
      'the enforce seam must default to the real assertCanEnforceEgressAllowList',
    );
    // The catch this whole soft pins: stop() BEFORE the rethrow, still inside the ctor try.
    assert.match(
      src,
      /catch \(err\) \{\s*if \(proxy\) \{\s*await proxy\.stop\(\);\s*proxy = undefined;\s*\}\s*throw err;/,
      'the ctor-throw catch must stop the proxy and rethrow (gate mutant W1)',
    );
  });
});
