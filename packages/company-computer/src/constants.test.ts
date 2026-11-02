/**
 * Slice 1 pins: canonical /opt mounts, per-agent container naming, pinned image,
 * port base. The discarded /home/derek/company-computers shared-overlay draft must
 * not return — these pins are the PM+Ops lock.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  assertSafeRef,
  companyRefFor,
  containerName,
  CONTAINER_DATA_MOUNT,
  CONTAINER_HOME_MOUNT,
  CONTAINER_VNC_PORT,
  hostAgentHomeDir,
  hostCompanyDataDir,
  InvalidRefError,
  KASM_IMAGE,
  PORT_BASE,
} from './constants';
import { ensureCompanyDirs, isCanonicalHostPath, mountsForAgent } from './ensure-company-dirs';

describe('canonical mounts (PM+Ops lock)', () => {
  it('company data dir is /opt/tourbillon-company-{id}/data', () => {
    assert.equal(hostCompanyDataDir('acme42'), '/opt/tourbillon-company-acme42/data');
  });

  it('agent home dir is /opt/tourbillon-company-{id}/home/{urlKey}', () => {
    assert.equal(hostAgentHomeDir('acme42', 'ceo'), '/opt/tourbillon-company-acme42/home/ceo');
  });

  it('container mounts are /data and /home/kasm-user (no shared-overlay target)', () => {
    assert.equal(CONTAINER_DATA_MOUNT, '/data');
    assert.equal(CONTAINER_HOME_MOUNT, '/home/kasm-user');
    const mounts = mountsForAgent('acme42', 'ceo');
    assert.deepEqual(mounts, [
      { source: '/opt/tourbillon-company-acme42/data', target: '/data' },
      { source: '/opt/tourbillon-company-acme42/home/ceo', target: '/home/kasm-user' },
    ]);
  });

  it('rejects the discarded Ops first-draft layout as non-canonical', () => {
    const stale = '/home/derek/company-computers/acme/shared/data';
    assert.equal(isCanonicalHostPath(stale, 'acme'), false);
    assert.equal(isCanonicalHostPath('/opt/tourbillon-company-acme/data', 'acme'), true);
    // Home is bound per-agent at /home/kasm-user directly — never a subdirectory of it.
    assert.ok(!CONTAINER_HOME_MOUNT.includes('shared'));
  });

  it('ensuresCompanyDirs plans root, data and per-agent homes without touching fs', () => {
    const plan = ensureCompanyDirs('c-1', ['ceo', 'cto']);
    assert.equal(plan.root, '/opt/tourbillon-company-c-1');
    assert.equal(plan.dataDir, '/opt/tourbillon-company-c-1/data');
    assert.deepEqual(plan.agentHomeDirs, [
      '/opt/tourbillon-company-c-1/home/ceo',
      '/opt/tourbillon-company-c-1/home/cto',
    ]);
  });

  it('path helpers reject traversal / unsafe refs before building a path', () => {
    assert.throws(() => ensureCompanyDirs('../evil'), InvalidRefError);
    assert.throws(() => ensureCompanyDirs('ok', ['../etc']), InvalidRefError);
    assert.throws(() => mountsForAgent('ok', 'a b'), InvalidRefError);
    assert.throws(() => assertSafeRef('', 'x'), InvalidRefError);
  });
});

describe('container + image constants', () => {
  it('pins kasmweb/desktop and KasmVNC ports', () => {
    assert.equal(KASM_IMAGE, 'kasmweb/desktop:1.19.0');
    assert.equal(CONTAINER_VNC_PORT, 6901);
    assert.equal(PORT_BASE, 6901);
  });

  it('names seats cc-<slug-or-id>-<urlKey>', () => {
    assert.equal(containerName('acme', 'ceo'), 'cc-acme-ceo');
    assert.equal(containerName('b8a1f2c3-uuid-like', 'eng-001'), 'cc-b8a1f2c3-uuid-like-eng-001');
  });

  it('companyRefFor prefers the slug, falls back to the id', () => {
    assert.equal(companyRefFor('acme', 'id-1'), 'acme');
    assert.equal(companyRefFor(null, 'id-1'), 'id-1');
    assert.equal(companyRefFor('  ', 'id-1'), 'id-1');
    assert.equal(companyRefFor('Bad Slug!', 'id-1'), 'id-1'); // unsafe slug falls back to id
  });
});
