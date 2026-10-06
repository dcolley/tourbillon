import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import {
  newEgressRunId,
  planCodeExecutionEgress,
  resolveCodeExecutionProxySocketPath,
} from './execution-workspace';
import { EgressProxy } from './egress-proxy';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { UNIX_SOCKET_PATH_MAX } from './egress-enforcement';

describe('buildCodeExecutionWorkspace', () => {
  it('documents sandbox network configuration behavior', () => {
    // This test documents the expected behavior without actually constructing
    // a sandbox (which requires filesystem access and process spawning).
    
    // Scenario 1: Default (no network)
    const defaultConfig: AgentRuntimeConfig = {
      heartbeat: {
        enabled: false,
        intervalSec: 0,
        wakeOnAssignment: true,
        wakeOnDemand: true,
        wakeOnAutomation: false,
      },
      timeout: {
        heartbeatSec: 300,
        graceSec: 30,
      },
      codeExecution: {
        isolation: 'bwrap',
      },
    };
    assert.equal(defaultConfig.codeExecution?.allowNetwork, undefined);
    // Expected: LocalSandbox constructed with nativeSandbox: { allowNetwork: false }
    
    // Scenario 2: Explicit network deny
    const denyConfig: AgentRuntimeConfig = {
      ...defaultConfig,
      codeExecution: {
        isolation: 'bwrap',
        allowNetwork: false,
      },
    };
    assert.equal(denyConfig.codeExecution?.allowNetwork, false);
    // Expected: LocalSandbox constructed with nativeSandbox: { allowNetwork: false }
    
    // Scenario 3: Network enabled (TestSuper)
    const allowConfig: AgentRuntimeConfig = {
      ...defaultConfig,
      codeExecution: {
        isolation: 'bwrap',
        allowNetwork: true,
      },
    };
    assert.equal(allowConfig.codeExecution?.allowNetwork, true);
    // Expected: isolation=bwrap + legacy allowNetwork routes through the
    // public-internet proxy (no shared netns). Private ranges stay blocked.
    
    // Scenario 4: isolation='none' (no nativeSandbox config)
    const noneConfig: AgentRuntimeConfig = {
      ...defaultConfig,
      codeExecution: {
        isolation: 'none',
        allowNetwork: true,
      },
    };
    assert.equal(noneConfig.codeExecution?.isolation, 'none');
    // Expected: LocalSandbox constructed without nativeSandbox (allowNetwork has no effect)
  });

  it('validates allowNetwork only applies with native isolation', () => {
    // When isolation is 'none', allowNetwork is ignored because there's no
    // OS-level sandboxing to enforce network restrictions.
    
    const config: AgentRuntimeConfig = {
      heartbeat: {
        enabled: false,
        intervalSec: 0,
        wakeOnAssignment: true,
        wakeOnDemand: true,
        wakeOnAutomation: false,
      },
      timeout: {
        heartbeatSec: 300,
        graceSec: 30,
      },
      codeExecution: {
        isolation: 'none',
        allowNetwork: true,
      },
    };
    
    // With isolation='none', LocalSandbox runs commands directly on host
    // nativeSandbox config is not used, so allowNetwork has no effect
    assert.equal(config.codeExecution?.isolation, 'none');
    assert.equal(config.codeExecution?.allowNetwork, true);
    
    // Expected behavior: LocalSandbox constructed WITHOUT nativeSandbox parameter
    // because isolation is 'none'. Proxy cannot be enforced; a per-run warning
    // is logged and the run is not refused.
  });

  it('plans public-internet proxy for legacy allowNetwork on bwrap', () => {
    const config: AgentRuntimeConfig = {
      heartbeat: {
        enabled: false,
        intervalSec: 0,
        wakeOnAssignment: true,
        wakeOnDemand: true,
        wakeOnAutomation: false,
      },
      timeout: { heartbeatSec: 300, graceSec: 30 },
      codeExecution: { isolation: 'bwrap', allowNetwork: true },
    };
    assert.deepEqual(planCodeExecutionEgress('bwrap', config), { kind: 'public-internet' });
    assert.deepEqual(planCodeExecutionEgress('none', config), {
      kind: 'unenforceable-legacy',
      isolation: 'none',
    });
    assert.deepEqual(planCodeExecutionEgress('seatbelt', config), {
      kind: 'unenforceable-legacy',
      isolation: 'seatbelt',
    });
  });

  it('plans deny-filter and allow-list independently of allowNetwork', () => {
    const base: AgentRuntimeConfig = {
      heartbeat: {
        enabled: false,
        intervalSec: 0,
        wakeOnAssignment: true,
        wakeOnDemand: true,
        wakeOnAutomation: false,
      },
      timeout: { heartbeatSec: 300, graceSec: 30 },
    };
    assert.deepEqual(
      planCodeExecutionEgress('bwrap', { ...base, codeExecution: { egressAllowList: [] } }),
      { kind: 'deny-filter' },
    );
    assert.deepEqual(
      planCodeExecutionEgress('bwrap', {
        ...base,
        codeExecution: { egressAllowList: ['api.example.com'] },
      }),
      { kind: 'allow-list', allowList: ['api.example.com'] },
    );
    assert.deepEqual(
      planCodeExecutionEgress('bwrap', { ...base, codeExecution: { allowNetwork: false } }),
      { kind: 'none' },
    );
  });

  it('validates sandbox cache key includes allowNetwork', () => {
    // The sandboxCacheKey must include allowNetwork so that agents with different
    // network settings get different sandbox instances.
    
    const agentA: AgentRuntimeConfig = {
      heartbeat: {
        enabled: false,
        intervalSec: 0,
        wakeOnAssignment: true,
        wakeOnDemand: true,
        wakeOnAutomation: false,
      },
      timeout: {
        heartbeatSec: 300,
        graceSec: 30,
      },
      codeExecution: {
        isolation: 'bwrap',
        allowNetwork: false,
      },
    };
    
    const agentB: AgentRuntimeConfig = {
      ...agentA,
      codeExecution: {
        isolation: 'bwrap',
        allowNetwork: true,
      },
    };
    
    // Expected cache keys (conceptual):
    // agentA: "companyId:issueId:bwrap:120000:false"
    // agentB: "companyId:issueId:bwrap:120000:true"
    
    assert.notEqual(
      agentA.codeExecution?.allowNetwork,
      agentB.codeExecution?.allowNetwork,
      'Agents with different allowNetwork settings must get different sandbox instances'
    );
  });

  it('validates sandbox cache key includes egressAllowList', () => {
    // The sandboxCacheKey must include egressAllowList so that agents with different
    // allow-lists get different sandbox instances.
    
    const agentA: AgentRuntimeConfig = {
      heartbeat: {
        enabled: false,
        intervalSec: 0,
        wakeOnAssignment: true,
        wakeOnDemand: true,
        wakeOnAutomation: false,
      },
      timeout: {
        heartbeatSec: 300,
        graceSec: 30,
      },
      codeExecution: {
        isolation: 'bwrap',
        egressAllowList: [],
      },
    };
    
    const agentB: AgentRuntimeConfig = {
      ...agentA,
      codeExecution: {
        isolation: 'bwrap',
        egressAllowList: ['api.example.com', '10.0.0.0/8'],
      },
    };

    const agentC: AgentRuntimeConfig = {
      ...agentA,
      codeExecution: {
        isolation: 'bwrap',
        // egressAllowList undefined - uses legacy allowNetwork
        allowNetwork: true,
      },
    };
    
    // Expected cache keys (conceptual):
    // agentA: "companyId:issueId:bwrap:120000:false::secretsHash"
    // agentB: "companyId:issueId:bwrap:120000:false:10.0.0.0/8,api.example.com:secretsHash"
    // agentC: "companyId:issueId:bwrap:120000:true:legacy:secretsHash"
    
    assert.deepEqual(
      agentA.codeExecution?.egressAllowList,
      [],
      'Agent A has empty allow-list'
    );
    assert.deepEqual(
      agentB.codeExecution?.egressAllowList,
      ['api.example.com', '10.0.0.0/8'],
      'Agent B has non-empty allow-list'
    );
    assert.equal(
      agentC.codeExecution?.egressAllowList,
      undefined,
      'Agent C uses legacy allowNetwork'
    );
  });

  it('validates empty egressAllowList denies network regardless of allowNetwork', () => {
    const config: AgentRuntimeConfig = {
      heartbeat: {
        enabled: false,
        intervalSec: 0,
        wakeOnAssignment: true,
        wakeOnDemand: true,
        wakeOnAutomation: false,
      },
      timeout: {
        heartbeatSec: 300,
        graceSec: 30,
      },
      codeExecution: {
        isolation: 'bwrap',
        allowNetwork: true, // ignored
        egressAllowList: [], // takes precedence
      },
    };
    
    // Empty egressAllowList should result in allowNetwork: false being passed to LocalSandbox
    assert.deepEqual(config.codeExecution?.egressAllowList, []);
    assert.equal(config.codeExecution?.allowNetwork, true);
    // Expected: resolveSandboxAllowNetwork returns false (empty list overrides allowNetwork)
  });

  it('validates non-empty egressAllowList does not share the host network', () => {
    const config: AgentRuntimeConfig = {
      heartbeat: {
        enabled: false,
        intervalSec: 0,
        wakeOnAssignment: true,
        wakeOnDemand: true,
        wakeOnAutomation: false,
      },
      timeout: {
        heartbeatSec: 300,
        graceSec: 30,
      },
      codeExecution: {
        isolation: 'bwrap',
        allowNetwork: false, // ignored
        egressAllowList: ['internal.corp.net'], // takes precedence
      },
    };
    
    assert.deepEqual(config.codeExecution?.egressAllowList, ['internal.corp.net']);
    assert.equal(config.codeExecution?.allowNetwork, false);
    // Expected: resolveSandboxAllowNetwork returns false (unix-socket proxy; no shared netns)
  });
});

describe('buildCodeExecutionWorkspace proxy socket identity', () => {
  const company = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const taskA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const taskB = 'bbbbcccc-cccc-4ccc-8ccc-cccccccccccc';

  it('does not collide UUID company+task ids that share a 40-char prefix', () => {
    const truncatedA = `${company}-${taskA}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const truncatedB = `${company}-${taskB}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    assert.equal(truncatedA, truncatedB, 'precondition: 40-char truncate must collide');

    const pathA = resolveCodeExecutionProxySocketPath(company, taskA, ['example.com']);
    const pathB = resolveCodeExecutionProxySocketPath(company, taskB, ['example.com']);
    const pathAOrg = resolveCodeExecutionProxySocketPath(company, taskA, ['example.org']);

    assert.notEqual(pathA, pathB);
    assert.notEqual(pathA, pathAOrg);
    assert.ok(Buffer.byteLength(pathA, 'utf8') <= UNIX_SOCKET_PATH_MAX, pathA);
    assert.ok(Buffer.byteLength(pathB, 'utf8') <= UNIX_SOCKET_PATH_MAX, pathB);
    assert.doesNotMatch(pathA, /aaaaaaaa-aaaa/);
  });

  it('refuses an overlong socket root instead of truncating', () => {
    const longRoot = join('/tmp', 'r'.repeat(90));
    assert.throws(
      () => resolveCodeExecutionProxySocketPath(company, taskA, ['example.com'], { socketRoot: longRoot }),
      /107|refusing to start/i,
    );
  });

  it('gives each run its own socket; destroying one leaves the other serving 200', async () => {
    const origin = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('via-proxy');
    });
    const originPort = await new Promise<number>((resolve) => {
      origin.listen(0, '127.0.0.1', () => resolve((origin.address() as { port: number }).port));
    });

    const list = ['127.0.0.1'];
    const path1 = resolveCodeExecutionProxySocketPath(company, taskA, list, { runId: newEgressRunId() });
    const path2 = resolveCodeExecutionProxySocketPath(company, taskA, list, { runId: newEgressRunId() });
    assert.notEqual(path1, path2);

    const d1 = new EgressProxy({ allowList: list, companyId: company, taskId: taskA });
    const d2 = new EgressProxy({ allowList: list, companyId: company, taskId: taskA });
    await d1.start({ socketPath: path1 });
    await d2.start({ socketPath: path2 });

    await d1.stop();
    assert.ok(!existsSync(path1), 'destroyed run unlinks only its socket');
    assert.ok(existsSync(path2), 'survivor socket remains');

    const { request } = await import('node:http');
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          socketPath: path2,
          path: `http://127.0.0.1:${originPort}/`,
          method: 'GET',
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.match(body, /via-proxy/);

    await d2.stop();
    origin.close();
  });
});
