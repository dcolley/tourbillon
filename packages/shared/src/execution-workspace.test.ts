import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { resolveSandboxAllowNetwork } from './execution-workspace';
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
