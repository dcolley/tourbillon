/**
 * Settings-stub enable flow: flips the injected flag store and returns the canonical
 * /opt dir plan — zero filesystem/Docker side effects in Slice 1.
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import {
  disableComputerForAgent,
  disableComputerForCompany,
  enableComputerForAgent,
  enableComputerForCompany,
  type ComputerFlagsStore,
} from './settings';
import { InvalidRefError } from './constants';

function fakeStore() {
  const writes: Array<{ table: 'company' | 'agent'; id: string; value: boolean }> = [];
  const store: ComputerFlagsStore = {
    async setCompanyHasComputer(id, value) {
      writes.push({ table: 'company', id, value });
    },
    async setAgentHasComputer(id, value) {
      writes.push({ table: 'agent', id, value });
    },
  };
  return { store, writes };
}

describe('settings stub enable/disable (no live docker, no fs)', () => {
  let f: ReturnType<typeof fakeStore>;
  beforeEach(() => {
    f = fakeStore();
  });

  it('company enable writes the flag and plans canonical dirs only', async () => {
    const res = await enableComputerForCompany(f.store, 'c-1', ['ceo', 'cto']);
    assert.deepEqual(f.writes, [{ table: 'company', id: 'c-1', value: true }]);
    assert.equal(res.hasComputer, true);
    assert.equal(res.provisioned, false, 'Slice 1 never claims provisioning');
    assert.equal(res.dirs.dataDir, '/opt/tourbillon-company-c-1/data');
    assert.deepEqual(res.dirs.agentHomeDirs, [
      '/opt/tourbillon-company-c-1/home/ceo',
      '/opt/tourbillon-company-c-1/home/cto',
    ]);
  });

  it('company disable closes gate 1', async () => {
    await disableComputerForCompany(f.store, 'c-1');
    assert.deepEqual(f.writes, [{ table: 'company', id: 'c-1', value: false }]);
  });

  it('agent enable writes gate 2 and returns the agent home plan path', async () => {
    const res = await enableComputerForAgent(f.store, 'a-1', 'c-1', 'ceo');
    assert.deepEqual(f.writes, [{ table: 'agent', id: 'a-1', value: true }]);
    assert.equal(res.homeDir, '/opt/tourbillon-company-c-1/home/ceo');
  });

  it('agent disable closes gate 2', async () => {
    await disableComputerForAgent(f.store, 'a-1');
    assert.deepEqual(f.writes, [{ table: 'agent', id: 'a-1', value: false }]);
  });

  it('rejects unsafe ids before touching the store', async () => {
    await assert.rejects(() => enableComputerForCompany(f.store, 'nope/../x'), InvalidRefError);
    await assert.rejects(() => enableComputerForAgent(f.store, 'a', 'c', 'Bad Key'), InvalidRefError);
    assert.deepEqual(f.writes, []);
  });
});
