/**
 * Lifecycle with a MOCKED HostClient + in-memory registry. Slice 1 must never start a
 * container: the dry-run client's refusal is asserted too (zero seats on Spark1 until
 * Derek enables via the Ops contract).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  allocatePort,
  buildContainerSpec,
  createSession,
  destroySession,
  generateVncPassword,
  getSession,
  touchSession,
} from './lifecycle';
import { InMemorySessionStore } from './session-registry';
import { createDryRunHostClient } from './host-client';
import { GateError, HostBackendUnavailableError, HostStartRefusedError, type ComputerContext, type ContainerSpec, type HostClient } from './types';
import { GATE_AGENT_NO_COMPUTER, GATE_COMPANY_NOT_PROVISIONED, KASM_IMAGE } from './constants';

function ctx(overrides: Partial<ComputerContext> = {}): ComputerContext {
  return {
    companyId: 'c-1',
    agentId: 'a-1',
    agentUrlKey: 'ceo',
    companySlug: 'acme',
    companyHasComputer: true,
    agentHasComputer: true,
    ...overrides,
  };
}

interface Call { op: string; arg: string }

function mockHost(overrides: Partial<HostClient> = {}) {
  const calls: Call[] = [];
  const host: HostClient = {
    async ensureDirs(dirs) {
      calls.push({ op: 'ensureDirs', arg: dirs.join(',') });
    },
    async startContainer(spec: ContainerSpec) {
      calls.push({ op: 'start', arg: spec.name });
      return { containerId: `cid-${spec.name}`, startedAt: new Date('2026-10-31T09:00:00Z') };
    },
    async stopAndRemove(name) {
      calls.push({ op: 'stop', arg: name });
    },
    async healthCheck() {
      calls.push({ op: 'health', arg: 'probe' });
      return true;
    },
    async execInContainer() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async screenshot() {
      return { imageBase64: 'AAEC', width: 1920, height: 1080 };
    },
    async sendInput() {
      return { success: true };
    },
    ...overrides,
  };
  return { host, calls };
}

const FIXED = new Date('2026-10-31T09:00:00Z');

function deps(store = new InMemorySessionStore(), host = mockHost().host) {
  return { store, hostClient: host, now: () => new Date(FIXED.getTime()), newSessionId: () => 'ccs-test-1' };
}

describe('createSession (mocked host)', () => {
  it('closed company gate throws before ANY host call', async () => {
    const { host, calls } = mockHost();
    const store = new InMemorySessionStore();
    await assert.rejects(
      () => createSession(ctx({ companyHasComputer: false }), { store, hostClient: host }),
      (err: GateError) => err.code === 'company_not_provisioned',
    );
    assert.deepEqual(calls, [], 'no ensureDirs/start before gates pass');
    assert.deepEqual(store.all(), []);
  });

  it('closed agent gate throws before ANY host call (toolset never bypasses)', async () => {
    const { host, calls } = mockHost();
    await assert.rejects(
      () => createSession(ctx({ agentHasComputer: false }), deps(new InMemorySessionStore(), host)),
      (err: GateError) => err.code === 'agent_no_computer',
    );
    assert.deepEqual(calls, []);
  });

  it('opens the seat with the canonical spec: name, image, /opt mounts, port', async () => {
    const { host, calls } = mockHost();
    const d = deps(new InMemorySessionStore(), host);
    const session = await createSession(ctx(), d);

    assert.equal(session.containerName, 'cc-acme-ceo');
    assert.equal(session.image, KASM_IMAGE);
    assert.equal(session.vncPort, 6901);
    assert.equal(session.status, 'running');
    assert.deepEqual(calls.map((c) => c.op), ['ensureDirs', 'start']);
    assert.equal(
      calls[0].arg,
      '/opt/tourbillon-company-c-1/data,/opt/tourbillon-company-c-1/home/ceo',
    );

    // Registry row survives; lastActivity set.
    const again = await d.store.findActiveByAgent('a-1');
    assert.equal(again?.id, 'ccs-test-1');
    assert.equal(again?.lastActivityAt?.toISOString(), FIXED.toISOString());
  });

  it('is idempotent: an existing live seat is returned, host untouched', async () => {
    const { host, calls } = mockHost();
    const d = deps(new InMemorySessionStore(), host);
    const first = await createSession(ctx(), d);
    const callsAfterFirst = calls.length;
    const second = await createSession(ctx(), d);
    assert.equal(second.id, first.id);
    assert.equal(calls.length, callsAfterFirst, 'no second start');
  });

  it('destroyed sessions do not block a fresh seat, and ports skip live ones', async () => {
    const store = new InMemorySessionStore();
    store.seed({
      id: 'old', companyId: 'c-1', agentId: 'a-9', agentUrlKey: 'cto',
      containerName: 'cc-acme-cto', image: KASM_IMAGE, vncPort: 6901, status: 'destroyed',
      createdAt: FIXED, updatedAt: FIXED, startedAt: null, destroyedAt: FIXED, lastActivityAt: null,
      takeoverStatus: null, takeoverUserId: null,
    });
    assert.equal(await allocatePort(store), 6901, 'destroyed frees its port');

    store.seed({
      id: 'live', companyId: 'c-1', agentId: 'a-8', agentUrlKey: 'eng',
      containerName: 'cc-acme-eng', image: KASM_IMAGE, vncPort: 6901, status: 'running',
      createdAt: FIXED, updatedAt: FIXED, startedAt: FIXED, destroyedAt: null, lastActivityAt: null,
      takeoverStatus: null, takeoverUserId: null,
    });
    assert.equal(await allocatePort(store), 6902, 'live seat holds its port');
  });

  it('port allocation is HOST-WIDE: two companies never share a port (#282 B2)', async () => {
    const { host } = mockHost();
    const store = new InMemorySessionStore();
    let n = 0;
    const d = { store, hostClient: host, now: () => new Date(FIXED.getTime()), newSessionId: () => `ccs-hw-${++n}` };
    // Company c-1 takes the first port from PORT_BASE.
    const first = await createSession(ctx({ companyId: 'c-1', agentId: 'a-1', agentUrlKey: 'ceo' }), d);
    assert.equal(first.vncPort, 6901);
    // A DIFFERENT company's seat must skip 6901 even though its own company holds no ports.
    const second = await createSession(
      ctx({ companyId: 'c-2', agentId: 'b-1', agentUrlKey: 'ceo', companySlug: 'other' }),
      d,
    );
    assert.equal(second.vncPort, 6902, 'host-wide allocation: c-2 cannot reuse c-1\'s 6901');
    // A third seat (same company as the first) keeps climbing too.
    const third = await createSession(
      ctx({ companyId: 'c-1', agentId: 'a-2', agentUrlKey: 'cto' }),
      d,
    );
    assert.equal(third.vncPort, 6903);
    const ports = store.all().map((s) => s.vncPort);
    assert.equal(new Set(ports).size, ports.length, 'all live host ports unique from PORT_BASE');
  });

  it('buildContainerSpec binds ONLY the two canonical mounts over /data and /home/kasm-user', () => {
    const spec = buildContainerSpec(ctx(), 6903);
    assert.equal(spec.name, 'cc-acme-ceo');
    assert.equal(spec.image, KASM_IMAGE);
    assert.equal(spec.containerPort, 6901);
    assert.equal(spec.hostPort, 6903);
    assert.deepEqual(spec.mounts, [
      { source: '/opt/tourbillon-company-c-1/data', target: '/data' },
      { source: '/opt/tourbillon-company-c-1/home/ceo', target: '/home/kasm-user' },
    ]);
    assert.ok(!JSON.stringify(spec.mounts).includes('/home/kasm-user/shared'));
    assert.ok(!JSON.stringify(spec).includes('company-computers'));
    assert.equal(spec.env.VNC_PORT, '6901');
    assert.ok(spec.env.VNC_PW.length >= 16);
  });

  it('company without a slug names the seat with the id', async () => {
    const { host } = mockHost();
    const session = await createSession(ctx({ companySlug: null }), deps(new InMemorySessionStore(), host));
    assert.equal(session.containerName, 'cc-c-1-ceo');
  });

  it('seat rows carry the Ops resource envelope: shm 512m, ~2GiB, ~1.5 CPU', () => {
    const spec = buildContainerSpec(ctx(), 6901);
    assert.equal(spec.shmSizeBytes, 512 * 1024 * 1024);
    assert.equal(spec.memoryBytes, 2 * 1024 * 1024 * 1024);
    assert.equal(spec.nanoCpus, 1_500_000_000);
  });
});

describe('createSession seat cap (Ops brief: max 4 TEST seats)', () => {
  function seedSeat(store: InMemorySessionStore, id: string, agentId: string, urlKey: string, status: 'running' | 'destroyed' = 'running') {
    store.seed({
      id,
      companyId: 'c-1',
      agentId,
      agentUrlKey: urlKey,
      containerName: `cc-acme-${urlKey}`,
      image: KASM_IMAGE,
      vncPort: 6900 + parseInt(id.replace('ccs-', ''), 10),
      status,
      createdAt: FIXED,
      updatedAt: FIXED,
      startedAt: FIXED,
      destroyedAt: null,
      lastActivityAt: FIXED,
      takeoverStatus: null,
      takeoverUserId: null,
    });
  }

  it('refuses the 5th concurrent seat with seat_cap_exceeded before touching the host', async () => {
    const { host, calls } = mockHost();
    const store = new InMemorySessionStore();
    for (let i = 1; i <= 4; i++) seedSeat(store, `ccs-${i}`, `a-${i}`, `bot${i}`);
    await assert.rejects(
      () => createSession(ctx({ agentId: 'a-5', agentUrlKey: 'bot5' }), deps(store, host)),
      (err: Error & { code?: string }) => err.name === 'SeatCapExceededError' && err.code === 'seat_cap_exceeded',
    );
    assert.deepEqual(calls, [], 'cap refusal happens before any host call');
  });

  it('reuses the agent\'s own seat even at the cap; destroyed rows do not count', async () => {
    const { host } = mockHost();
    const store = new InMemorySessionStore();
    for (let i = 1; i <= 4; i++) seedSeat(store, `ccs-${i}`, `a-${i}`, `bot${i}`);
    // The capped agent already has a seat (one of the four) -> reuse, no throw.
    const reused = await createSession(ctx({ agentId: 'a-2', agentUrlKey: 'bot2' }), deps(store, host));
    assert.equal(reused.id, 'ccs-2');
    // Free one slot -> the new seat is allowed again.
    await store.update('ccs-1', { status: 'destroyed' });
    const created = await createSession(ctx({ agentId: 'a-5', agentUrlKey: 'bot5' }), deps(store, host));
    assert.equal(created.agentId, 'a-5');
  });
});

describe('dry-run HostClient refuses starts (Slice 1 host policy)', () => {
  it('default env: createSession surfaces host_start_refused, registry stays empty', async () => {
    const store = new InMemorySessionStore();
    const host = createDryRunHostClient({ env: {} });
    await assert.rejects(
      () => createSession(ctx(), { store, hostClient: host, now: () => FIXED }),
      (err: HostStartRefusedError) =>
        err instanceof HostStartRefusedError && err.code === 'host_start_refused',
    );
    assert.deepEqual(store.all(), [], 'no phantom session row on refused start');
  });

  it('even CC_ALLOW_START=1 without Ops scripts refuses (ops_contract_missing)', async () => {
    const host = createDryRunHostClient({ env: { CC_ALLOW_START: '1' }, opsScriptExists: () => false });
    await assert.rejects(
      () => createSession(ctx(), { store: new InMemorySessionStore(), hostClient: host }),
      (err: Error) => (err as { code?: string }).code === 'ops_contract_missing',
    );
  });
});

describe('getSession / destroySession', () => {
  it('getSession gates first, then returns null with no seat', async () => {
    const { host } = mockHost();
    const d = deps(new InMemorySessionStore(), host);
    // Gate is checked before the registry read.
    await assert.rejects(
      () => getSession(ctx({ companyHasComputer: false }), d),
      (err: GateError) => err.code === 'company_not_provisioned',
    );
    assert.equal(await getSession(ctx(), d), null);
  });

  it('probe demotes a dead container to stopped', async () => {
    const { host } = mockHost({ healthCheck: async () => false });
    const d = deps(new InMemorySessionStore(), host);
    const session = await createSession(ctx(), d);
    const probed = await getSession(ctx(), d, { probe: true });
    assert.equal(probed?.status, 'stopped');
    assert.equal((await d.store.getById(session.id))?.status, 'stopped');
  });

  it('destroy removes the row from the active set even when the host errors', async () => {
    const { host } = mockHost({
      stopAndRemove: async () => {
        throw new Error('docker daemon unreachable');
      },
    });
    const d = deps(new InMemorySessionStore(), host);
    const session = await createSession(ctx(), d);
    const result = await destroySession(ctx(), d);
    assert.equal(result.destroyed, true);
    assert.match(result.hostError ?? '', /docker daemon unreachable/);
    assert.equal(await d.store.findActiveByAgent('a-1'), null);
    assert.equal((await d.store.getById(session.id))?.status, 'destroyed');
  });

  it('destroy is idempotent with no seat', async () => {
    const d = deps();
    assert.deepEqual(await destroySession(ctx(), d), { destroyed: false });
  });

  it('touchSession bumps lastActivityAt', async () => {
    const d = deps();
    const session = await createSession(ctx(), d);
    const later = new Date(FIXED.getTime() + 60_000);
    await touchSession(session.id, { store: d.store, now: () => later });
    assert.equal((await d.store.getById(session.id))?.lastActivityAt?.toISOString(), later.toISOString());
  });
});

describe('VNC password', () => {
  it('is url-safe, long, and unique per call', () => {
    const a = generateVncPassword();
    const b = generateVncPassword();
    assert.ok(a.length >= 16 && b.length >= 16);
    assert.match(a, /^[A-Za-z0-9]+$/);
    assert.notEqual(a, b);
  });

  // ---- S282-S2 (mutants M30/M31): the seat's VNC password lives ONLY in the spec the
  // HostClient receives (env.VNC_PW -> vnc_pw file is Slice 2). It must never reach the
  // persisted session row, the returned session object, or any refusal message. ----

  const SESSION_KEYS = [
    'id', 'companyId', 'agentId', 'agentUrlKey', 'containerName', 'image', 'vncPort', 'status',
    'createdAt', 'updatedAt', 'startedAt', 'destroyedAt', 'lastActivityAt', 'takeoverStatus', 'takeoverUserId',
  ].sort();

  /** Mock host that keeps every spec it was handed, so the test knows the generated secret. */
  function recordingHost() {
    const specs: ContainerSpec[] = [];
    const { host } = mockHost({
      async startContainer(spec: ContainerSpec) {
        specs.push(structuredClone(spec));
        return { containerId: 'cid-rec', startedAt: FIXED };
      },
    });
    return { host, specs };
  }

  it('createSession persists no password: stored row and returned session carry exactly the registry columns, none holding the secret (M30)', async () => {
    const { host, specs } = recordingHost();
    const store = new InMemorySessionStore();
    const session = await createSession(ctx(), deps(store, host));
    assert.equal(specs.length, 1, 'host saw exactly one start');
    const pw = specs[0].env.VNC_PW;
    assert.ok(pw && pw.length >= 16, 'spec.env.VNC_PW carries the generated password (untouched, Slice 2 owns it)');

    assert.deepEqual(Object.keys(session).sort(), SESSION_KEYS, 'returned session: exact registry shape');
    assert.ok(!JSON.stringify(session).includes(pw), 'returned session serialises the secret');

    const rows = store.all();
    assert.equal(rows.length, 1);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), SESSION_KEYS, 'stored row: exact registry shape (no pw field)');
      assert.ok(!JSON.stringify(row).includes(pw), 'stored row serialises the secret');
      for (const v of Object.values(row)) {
        if (typeof v === 'string') assert.notEqual(v, pw, 'a string column holds the VNC password');
      }
    }
  });

  it('gate refusals are the locked wording verbatim — no room for a password value (M31)', async () => {
    const { host } = recordingHost();
    await assert.rejects(
      () => createSession(ctx({ companyHasComputer: false }), { store: new InMemorySessionStore(), hostClient: host }),
      (err: GateError) => err.message === GATE_COMPANY_NOT_PROVISIONED,
    );
    await assert.rejects(
      () => createSession(ctx({ agentHasComputer: false }), { store: new InMemorySessionStore(), hostClient: host }),
      (err: GateError) => err.message === GATE_AGENT_NO_COMPUTER,
    );
  });

  it('seat-cap refusal is the locked wording verbatim (M31)', async () => {
    const store = new InMemorySessionStore();
    for (let i = 1; i <= 4; i++) {
      store.seed({
        id: `ccs-${i}`, companyId: 'c-1', agentId: `a-${i}`, agentUrlKey: `bot${i}`,
        containerName: `cc-acme-bot${i}`, image: KASM_IMAGE, vncPort: 6900 + i, status: 'running',
        createdAt: FIXED, updatedAt: FIXED, startedAt: FIXED, destroyedAt: null, lastActivityAt: FIXED,
        takeoverStatus: null, takeoverUserId: null,
      });
    }
    await assert.rejects(
      () => createSession(ctx({ agentId: 'a-5', agentUrlKey: 'bot5' }), deps(store, recordingHost().host)),
      (err: Error) =>
        err.message ===
        'Company Computer seat cap reached: 4/4 seats active on this host. ' +
          'Close a seat (computerCloseSession) before opening a new one.',
    );
  });

  it('dry-run start refusals (host_start_refused / ops_contract_missing) never quote the generated password (M31)', async () => {
    for (const env of [{}, { CC_ALLOW_START: '1' }] as const) {
      const specs: ContainerSpec[] = [];
      const inner = createDryRunHostClient({ env: { ...env }, opsScriptExists: () => false });
      const host: HostClient = {
        ...inner,
        async startContainer(spec: ContainerSpec) {
          specs.push(structuredClone(spec));
          return inner.startContainer(spec);
        },
      };
      let refusal: Error | undefined;
      try {
        await createSession(ctx(), { store: new InMemorySessionStore(), hostClient: host, now: () => FIXED });
      } catch (err) {
        refusal = err as Error;
      }
      assert.ok(refusal, `expected a refusal for env ${JSON.stringify(env)}`);
      assert.ok(
        refusal instanceof HostStartRefusedError || refusal instanceof HostBackendUnavailableError,
        `unexpected refusal: ${String(refusal)}`,
      );
      assert.equal(specs.length, 1);
      const pw = specs[0].env.VNC_PW;
      assert.ok(pw && pw.length >= 16, 'the dry-run client received the spec with the password');
      assert.match(refusal.message, /cc-acme-ceo/, 'sanity: the refusal does quote the planned seat');
      assert.ok(!refusal.message.includes(pw), `refusal message leaks the VNC password: ${refusal.message}`);
      assert.ok(!String(refusal.stack ?? '').includes(pw), 'refusal stack leaks the VNC password');
    }
  });
});
