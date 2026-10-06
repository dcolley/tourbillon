import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { resolveSandboxAllowNetwork, resolveSandboxEgressAllowList } from './execution-workspace';
import type { AgentRuntimeConfig } from './types';

describe('resolveSandboxAllowNetwork', () => {
  it('returns false when runtimeConfig is null', () => {
    const result = resolveSandboxAllowNetwork(null);
    assert.equal(result, false);
  });

  it('returns false when runtimeConfig is undefined', () => {
    const result = resolveSandboxAllowNetwork(undefined);
    assert.equal(result, false);
  });

  it('returns false when codeExecution is undefined', () => {
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
    };
    const result = resolveSandboxAllowNetwork(config);
    assert.equal(result, false);
  });

  it('returns false when allowNetwork is explicitly false', () => {
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
        allowNetwork: false,
      },
    };
    const result = resolveSandboxAllowNetwork(config);
    assert.equal(result, false);
  });

  it('returns true when allowNetwork is true', () => {
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
        allowNetwork: true,
      },
    };
    const result = resolveSandboxAllowNetwork(config);
    assert.equal(result, true);
  });

  it('returns false when allowNetwork is undefined (default deny)', () => {
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
        timeoutMs: 60000,
        isolation: 'bwrap',
      },
    };
    const result = resolveSandboxAllowNetwork(config);
    assert.equal(result, false);
  });

  it('coexists with other codeExecution settings', () => {
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
        timeoutMs: 120000,
        isolation: 'seatbelt',
        allowNetwork: true,
      },
    };
    const result = resolveSandboxAllowNetwork(config);
    assert.equal(result, true);
  });
});

describe('resolveSandboxEgressAllowList', () => {
  it('returns undefined when runtimeConfig is null', () => {
    const result = resolveSandboxEgressAllowList(null);
    assert.equal(result, undefined);
  });

  it('returns undefined when runtimeConfig is undefined', () => {
    const result = resolveSandboxEgressAllowList(undefined);
    assert.equal(result, undefined);
  });

  it('returns undefined when codeExecution is undefined', () => {
    const config: AgentRuntimeConfig = {
      heartbeat: { enabled: false, intervalSec: 0, wakeOnAssignment: true, wakeOnDemand: true, wakeOnAutomation: false },
      timeout: { heartbeatSec: 300, graceSec: 30 },
    };
    const result = resolveSandboxEgressAllowList(config);
    assert.equal(result, undefined);
  });

  it('returns undefined when egressAllowList is not set', () => {
    const config: AgentRuntimeConfig = {
      heartbeat: { enabled: false, intervalSec: 0, wakeOnAssignment: true, wakeOnDemand: true, wakeOnAutomation: false },
      timeout: { heartbeatSec: 300, graceSec: 30 },
      codeExecution: { allowNetwork: true },
    };
    const result = resolveSandboxEgressAllowList(config);
    assert.equal(result, undefined);
  });

  it('returns empty array when egressAllowList is empty', () => {
    const config: AgentRuntimeConfig = {
      heartbeat: { enabled: false, intervalSec: 0, wakeOnAssignment: true, wakeOnDemand: true, wakeOnAutomation: false },
      timeout: { heartbeatSec: 300, graceSec: 30 },
      codeExecution: { egressAllowList: [] },
    };
    const result = resolveSandboxEgressAllowList(config);
    assert.deepEqual(result, []);
  });

  it('returns the allow-list when set', () => {
    const allowList = ['api.example.com', '10.0.0.0/8', 'db.internal.net'];
    const config: AgentRuntimeConfig = {
      heartbeat: { enabled: false, intervalSec: 0, wakeOnAssignment: true, wakeOnDemand: true, wakeOnAutomation: false },
      timeout: { heartbeatSec: 300, graceSec: 30 },
      codeExecution: { egressAllowList: allowList },
    };
    const result = resolveSandboxEgressAllowList(config);
    assert.deepEqual(result, allowList);
  });
});

describe('resolveSandboxAllowNetwork with egressAllowList', () => {
  it('returns false when egressAllowList is empty array (denies all)', () => {
    const config: AgentRuntimeConfig = {
      heartbeat: { enabled: false, intervalSec: 0, wakeOnAssignment: true, wakeOnDemand: true, wakeOnAutomation: false },
      timeout: { heartbeatSec: 300, graceSec: 30 },
      codeExecution: {
        allowNetwork: true, // legacy field ignored when egressAllowList is present
        egressAllowList: [],
      },
    };
    const result = resolveSandboxAllowNetwork(config);
    assert.equal(result, false, 'Empty egressAllowList should deny network even if allowNetwork is true');
  });

  it('returns true when egressAllowList has entries', () => {
    const config: AgentRuntimeConfig = {
      heartbeat: { enabled: false, intervalSec: 0, wakeOnAssignment: true, wakeOnDemand: true, wakeOnAutomation: false },
      timeout: { heartbeatSec: 300, graceSec: 30 },
      codeExecution: {
        allowNetwork: false, // legacy field ignored when egressAllowList is present
        egressAllowList: ['api.example.com'],
      },
    };
    const result = resolveSandboxAllowNetwork(config);
    assert.equal(result, true, 'Non-empty egressAllowList should enable network even if allowNetwork is false');
  });

  it('uses legacy allowNetwork boolean when egressAllowList is undefined', () => {
    const config: AgentRuntimeConfig = {
      heartbeat: { enabled: false, intervalSec: 0, wakeOnAssignment: true, wakeOnDemand: true, wakeOnAutomation: false },
      timeout: { heartbeatSec: 300, graceSec: 30 },
      codeExecution: {
        allowNetwork: true,
        // egressAllowList is undefined - should use allowNetwork
      },
    };
    const result = resolveSandboxAllowNetwork(config);
    assert.equal(result, true, 'Should fall back to allowNetwork when egressAllowList is undefined');
  });

  it('backward compatibility: allowNetwork=false when no egress list', () => {
    const config: AgentRuntimeConfig = {
      heartbeat: { enabled: false, intervalSec: 0, wakeOnAssignment: true, wakeOnDemand: true, wakeOnAutomation: false },
      timeout: { heartbeatSec: 300, graceSec: 30 },
      codeExecution: {
        allowNetwork: false,
      },
    };
    const result = resolveSandboxAllowNetwork(config);
    assert.equal(result, false, 'Legacy allowNetwork=false should still deny network');
  });
});
