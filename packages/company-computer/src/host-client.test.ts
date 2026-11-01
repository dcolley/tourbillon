/**
 * Dry-run HostClient pins (Ops contract 2026-10-31): the sanctioned host scripts are
 * the cc-* set under CC_BIN_DIR (default /home/derek/company-computers/bin). Slice 1
 * NEVER shells out: every path either no-ops (dry run) or refuses.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createDryRunHostClient } from './host-client';
import {
  CC_ENSURE_COMPANY_SCRIPT,
  CC_ENSURE_SEAT_SCRIPT,
  CC_TEARDOWN_SEAT_SCRIPT,
  ccBinPath,
  DEFAULT_CC_BIN_DIR,
} from './constants';
import { HostBackendUnavailableError, HostStartRefusedError, type ContainerSpec } from './types';

const SPEC: ContainerSpec = {
  name: 'cc-acme-ceo',
  image: 'kasmweb/desktop:1.19.0',
  containerPort: 6901,
  hostPort: 6901,
  env: {},
  mounts: [],
  shmSizeBytes: 1,
  memoryBytes: 1,
  nanoCpus: 1,
};

describe('cc-bin paths (Ops contract)', () => {
  it('defaults to /home/derek/company-computers/bin and honours CC_BIN_DIR', () => {
    assert.equal(ccBinPath(CC_ENSURE_SEAT_SCRIPT, {}), '/home/derek/company-computers/bin/cc-ensure-seat');
    assert.equal(
      ccBinPath(CC_TEARDOWN_SEAT_SCRIPT, { CC_BIN_DIR: '/srv/ops-bin/' }),
      '/srv/ops-bin/cc-teardown-seat',
    );
    assert.equal(DEFAULT_CC_BIN_DIR, '/home/derek/company-computers/bin');
    // The invented /opt/.../bin/ensure-* path must not be the default anywhere.
    assert.ok(!ccBinPath(CC_ENSURE_COMPANY_SCRIPT, {}).includes('tourbillon-company-computer/bin'));
  });
});

describe('dry-run HostClient refusal matrix', () => {
  it('no flags: start refuses with host_start_refused, nothing created or removed', async () => {
    const host = createDryRunHostClient({ env: {} });
    await assert.rejects(
      () => host.startContainer(SPEC),
      (err: HostStartRefusedError) => err instanceof HostStartRefusedError && err.code === 'host_start_refused',
    );
    await host.ensureDirs(['/opt/tourbillon-company-c1/data']); // no-op in dry run
    await host.stopAndRemove('cc-acme-ceo'); // no-op in dry run
    assert.equal(await host.healthCheck('cc-acme-ceo'), false);
  });

  it('CC_ALLOW_START=1 without cc-ensure-seat present refuses (ops_contract_missing)', async () => {
    const host = createDryRunHostClient({ env: { CC_ALLOW_START: '1' }, opsScriptExists: () => false });
    await assert.rejects(
      () => host.startContainer(SPEC),
      (err: HostBackendUnavailableError) =>
        err instanceof HostBackendUnavailableError &&
        err.code === 'ops_contract_missing' &&
        err.message.includes(CC_ENSURE_SEAT_SCRIPT),
    );
  });

  it('CC_ALLOW_START=1 with cc-ensure-seat present STILL refuses (Slice 1 never shells out)', async () => {
    const seen: string[] = [];
    const host = createDryRunHostClient({
      env: { CC_ALLOW_START: '1', CC_BIN_DIR: '/srv/ops-bin' },
      opsScriptExists: (script) => {
        seen.push(script);
        return true;
      },
    });
    await assert.rejects(
      () => host.startContainer(SPEC),
      (err: HostBackendUnavailableError) => err instanceof HostBackendUnavailableError,
    );
    assert.deepEqual(seen, ['/srv/ops-bin/cc-ensure-seat']);
  });

  it('CC_APPLY=1 with cc-ensure-company present still no-ops the dry-run ensureDirs path only when script missing', async () => {
    // Without the script, ensureDirs must be a silent no-op even with CC_APPLY=1.
    const host = createDryRunHostClient({ env: { CC_APPLY: '1' }, opsScriptExists: () => false });
    await host.ensureDirs(['/opt/tourbillon-company-c1/data']);

    // With the script present, Slice 1 refuses to run it (Slice 2 wires it).
    const wired = createDryRunHostClient({
      env: { CC_APPLY: '1' },
      opsScriptExists: (s) => s.endsWith(CC_ENSURE_COMPANY_SCRIPT),
    });
    await assert.rejects(
      () => wired.ensureDirs(['/opt/tourbillon-company-c1/data']),
      (err: HostBackendUnavailableError) =>
        err instanceof HostBackendUnavailableError && err.message.includes(CC_ENSURE_COMPANY_SCRIPT),
    );
  });

  it('CC_ALLOW_START=1 with cc-teardown-seat present refuses teardown in Slice 1', async () => {
    const host = createDryRunHostClient({
      env: { CC_ALLOW_START: '1' },
      opsScriptExists: (s) => s.endsWith(CC_TEARDOWN_SEAT_SCRIPT),
    });
    await assert.rejects(
      () => host.stopAndRemove('cc-acme-ceo'),
      (err: HostBackendUnavailableError) =>
        err instanceof HostBackendUnavailableError && err.message.includes(CC_TEARDOWN_SEAT_SCRIPT),
    );
  });

  it('exec / screenshot / sendInput always refuse in dry run', async () => {
    const host = createDryRunHostClient({ env: { CC_ALLOW_START: '1' } });
    await assert.rejects(() => host.execInContainer('cc-acme-ceo', ['xdg-open', 'https://example.com']));
    await assert.rejects(() => host.screenshot('cc-acme-ceo'));
    await assert.rejects(() => host.sendInput('cc-acme-ceo', { kind: 'type', text: 'hi' }));
  });
});
