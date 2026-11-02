/**
 * meta.json schema 2 pins (Ops contract): object-form mounts, sibling vnc_pw file,
 * no inline password, canonical /opt host roots only.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseSeatMeta, SeatMetaError, SEAT_META_SCHEMA, VNC_PW_FILENAME } from './ops-inventory';

const VALID = {
  schema: 2,
  containerName: 'cc-acme-ceo',
  hostPort: 6901,
  vncPasswordFile: VNC_PW_FILENAME,
  mounts: {
    '/opt/tourbillon-company-c1/data': '/data',
    '/opt/tourbillon-company-c1/home/ceo': '/home/kasm-user',
  },
};

describe('seat meta schema 2', () => {
  it('accepts the canonical schema 2 shape unchanged', () => {
    const meta = parseSeatMeta(VALID);
    assert.equal(meta.schema, SEAT_META_SCHEMA);
    assert.equal(meta.containerName, 'cc-acme-ceo');
    assert.equal(meta.hostPort, 6901);
    assert.equal(meta.vncPasswordFile, VNC_PW_FILENAME);
    assert.deepEqual(meta.mounts, VALID.mounts);
  });

  it('rejects schema 1 (inline password era)', () => {
    assert.throws(
      () => parseSeatMeta({ ...VALID, schema: 1 }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('schema 1'),
    );
  });

  it('rejects an embedded VNC password anywhere', () => {
    assert.throws(
      () => parseSeatMeta({ ...VALID, vncPassword: 'hunter2' }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('vncPassword'),
    );
    assert.throws(() => parseSeatMeta({ ...VALID, vnc_password: 'x' }), SeatMetaError);
  });

  it('rejects array-form mounts (schema 1 leftover)', () => {
    assert.throws(
      () => parseSeatMeta({ ...VALID, mounts: [{ source: '/opt/tourbillon-company-c1/data', target: '/data' }] }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('OBJECT form'),
    );
  });

  it('rejects non-sibling or absolute vncPasswordFile paths', () => {
    assert.throws(() => parseSeatMeta({ ...VALID, vncPasswordFile: '/etc/shadow' }), SeatMetaError);
    assert.throws(() => parseSeatMeta({ ...VALID, vncPasswordFile: '../vnc_pw' }), SeatMetaError);
    assert.throws(() => parseSeatMeta({ ...VALID, vncPasswordFile: '' }), SeatMetaError);
    // Must be a BARE basename (sibling file) — any directory component is rejected.
    assert.throws(
      () => parseSeatMeta({ ...VALID, vncPasswordFile: 'sub/vnc_pw' }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('bare sibling basename'),
    );
  });

  it('rejects mounts outside the canonical /opt/tourbillon-company-{id}/ root', () => {
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: { '/home/derek': '/home/kasm-user', '/opt/tourbillon-company-c1/data': '/data' },
        }),
      (err: SeatMetaError) =>
        err instanceof SeatMetaError &&
        (err.message.includes('canonical') || err.message.includes('agent home dir')),
    );
    assert.throws(
      // Discarded shared-overlay draft must not validate.
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: {
            '/home/derek/company-computers/acme/shared/home': '/home/kasm-user',
            '/opt/tourbillon-company-c1/data': '/data',
          },
        }),
      SeatMetaError,
    );
  });

  it('rejects container targets other than /data and /home/kasm-user', () => {
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: {
            '/opt/tourbillon-company-c1/data': '/home/kasm-user/shared',
            '/opt/tourbillon-company-c1/home/ceo': '/home/kasm-user',
          },
        }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('targets are allowed'),
    );
  });

  // ---- #282 B1 mount lock: one canonical pair per company id + urlKey, nothing else. ----

  const HOME_MOUNT = '/opt/tourbillon-company-c1/home/ceo';

  it('rejects a traversal host path (…/../../etc -> /data)', () => {
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: { '/opt/tourbillon-company-c1/data/../../etc': '/data', [HOME_MOUNT]: '/home/kasm-user' },
        }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('not normalised'),
    );
  });

  it('rejects the whole home tree mounted over /home/kasm-user', () => {
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: { '/opt/tourbillon-company-c1/data': '/data', '/opt/tourbillon-company-c1/home': '/home/kasm-user' },
        }),
      SeatMetaError,
    );
  });

  it("rejects another agent's home mounted in this seat", () => {
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID, // containerName cc-acme-ceo, but the home bind is cto's dir
          mounts: { '/opt/tourbillon-company-c1/data': '/data', '/opt/tourbillon-company-c1/home/cto': '/home/kasm-user' },
        }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('urlKey'),
    );
  });

  it('rejects the company root mounted at /data', () => {
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: { '/opt/tourbillon-company-c1': '/data', [HOME_MOUNT]: '/home/kasm-user' },
        }),
      SeatMetaError,
    );
  });

  it('rejects swapped targets (data dir -> /home/kasm-user, home -> /data)', () => {
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: { '/opt/tourbillon-company-c1/data': '/home/kasm-user', [HOME_MOUNT]: '/data' },
        }),
      SeatMetaError,
    );
  });

  it('rejects two companies mounted into one seat', () => {
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: { '/opt/tourbillon-company-c1/data': '/data', '/opt/tourbillon-company-c2/home/ceo': '/home/kasm-user' },
        }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('two companies'),
    );
  });

  it('rejects duplicate /home/kasm-user targets', () => {
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: { [HOME_MOUNT]: '/home/kasm-user', '/opt/tourbillon-company-c1/home/eng': '/home/kasm-user' },
        }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('more than once'),
    );
  });

  it('rejects non-normalised host paths (// and trailing slash)', () => {
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: { '/opt/tourbillon-company-c1//data': '/data', [HOME_MOUNT]: '/home/kasm-user' },
        }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('not normalised'),
    );
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: { '/opt/tourbillon-company-c1/data/': '/data', [HOME_MOUNT]: '/home/kasm-user' },
        }),
      SeatMetaError,
    );
  });

  it('rejects top-level keys outside the allowlist (incl. nested env.VNC_PW)', () => {
    assert.throws(
      () => parseSeatMeta({ ...VALID, env: { VNC_PW: 'hunter2' } }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('unknown top-level key "env"'),
    );
    assert.throws(() => parseSeatMeta({ ...VALID, image: 'ubuntu:latest' }), SeatMetaError);
  });

  it('rejects a containerName that does not end with the mounted urlKey', () => {
    assert.throws(
      () => parseSeatMeta({ ...VALID, containerName: 'cc-acme-cto' }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('urlKey'),
    );
  });

  it('rejects an unsafe agentUrlKey in the home mount', () => {
    assert.throws(
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: { '/opt/tourbillon-company-c1/data': '/data', '/opt/tourbillon-company-c1/home/CeO!': '/home/kasm-user' },
        }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('unsafe agentUrlKey'),
    );
  });

  it('rejects bad container names and out-of-range host ports', () => {
    assert.throws(() => parseSeatMeta({ ...VALID, containerName: 'kasm-ceo' }), SeatMetaError);
    assert.throws(() => parseSeatMeta({ ...VALID, hostPort: 80 }), SeatMetaError);
    assert.throws(() => parseSeatMeta({ ...VALID, hostPort: 6901.5 }), SeatMetaError);
  });

  it('rejects non-objects and empty mounts', () => {
    assert.throws(() => parseSeatMeta(null), SeatMetaError);
    assert.throws(() => parseSeatMeta([]), SeatMetaError);
    assert.throws(() => parseSeatMeta({ ...VALID, mounts: {} }), SeatMetaError);
  });
});
