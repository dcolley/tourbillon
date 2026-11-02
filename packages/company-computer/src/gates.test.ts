/**
 * Two-gate model pins: BOTH flags true or nothing happens; company gate is reported
 * first; locked wording.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { assertComputerGates, computerGatesOpen } from './gates';
import { GATE_AGENT_NO_COMPUTER, GATE_COMPANY_NOT_PROVISIONED } from './constants';
import { GateError } from './types';

describe('two-gate model', () => {
  it('only (true, true) opens the gate', () => {
    assert.equal(computerGatesOpen({ companyHasComputer: true, agentHasComputer: true }), true);
    assert.equal(computerGatesOpen({ companyHasComputer: true, agentHasComputer: false }), false);
    assert.equal(computerGatesOpen({ companyHasComputer: false, agentHasComputer: true }), false);
    assert.equal(computerGatesOpen({ companyHasComputer: false, agentHasComputer: false }), false);
  });

  it('strict equality: null/undefined/1 are NOT true', () => {
    for (const falsy of [null, undefined, 1, 'true', 0] as unknown[]) {
      assert.equal(computerGatesOpen({ companyHasComputer: true, agentHasComputer: falsy as boolean }), false);
      assert.equal(computerGatesOpen({ companyHasComputer: falsy as boolean, agentHasComputer: true }), false);
    }
  });

  it('company gate error wins when both closed', () => {
    assert.throws(
      () => assertComputerGates({ companyHasComputer: false, agentHasComputer: false }),
      (err: GateError) => err instanceof GateError && err.code === 'company_not_provisioned',
    );
  });

  it('locked wording (agents quote these back to the Board)', () => {
    assert.equal(GATE_COMPANY_NOT_PROVISIONED, 'Company Computer not provisioned. Ask Board to enable at /settings/company-computer.');
    assert.equal(GATE_AGENT_NO_COMPUTER, 'Agent does not have Computer access. Ask Board to enable hasComputer on the agent detail page.');
    assert.throws(
      () => assertComputerGates({ companyHasComputer: true, agentHasComputer: false }),
      { name: 'GateError', message: GATE_AGENT_NO_COMPUTER },
    );
  });

  it('the toolset is NOT a gate input: same outcome with or without it', () => {
    // There is deliberately no way to pass a toolset flag into the gate check.
    const gates = assertComputerGates as unknown as (...args: unknown[]) => void;
    assert.equal(gates.length, 1);
  });
});
