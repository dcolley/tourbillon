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
  });

  it('rejects mounts outside the canonical /opt/tourbillon-company-{id}/ root', () => {
    assert.throws(
      () => parseSeatMeta({ ...VALID, mounts: { '/home/derek': '/home/kasm-user' } }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('canonical'),
    );
    assert.throws(
      // Discarded shared-overlay draft must not validate.
      () =>
        parseSeatMeta({
          ...VALID,
          mounts: { '/home/derek/company-computers/acme/shared/home': '/home/kasm-user' },
        }),
      SeatMetaError,
    );
  });

  it('rejects container targets other than /data and /home/kasm-user', () => {
    assert.throws(
      () => parseSeatMeta({ ...VALID, mounts: { '/opt/tourbillon-company-c1/data': '/home/kasm-user/shared' } }),
      (err: SeatMetaError) => err instanceof SeatMetaError && err.message.includes('targets are allowed'),
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
