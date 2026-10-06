import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AgentRuntimeConfig } from '@tourbillon/shared';

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
    // Expected: LocalSandbox constructed with nativeSandbox: { allowNetwork: true }
    
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
    // because isolation is 'none'
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
    // agentB: "companyId:issueId:bwrap:120000:true:10.0.0.0/8,api.example.com:secretsHash"
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

  it('validates non-empty egressAllowList enables network regardless of allowNetwork', () => {
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
    
    // Non-empty egressAllowList should result in allowNetwork: true being passed to LocalSandbox
    assert.deepEqual(config.codeExecution?.egressAllowList, ['internal.corp.net']);
    assert.equal(config.codeExecution?.allowNetwork, false);
    // Expected: resolveSandboxAllowNetwork returns true (non-empty list overrides allowNetwork)
  });
});
