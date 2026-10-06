import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EgressProxy } from './egress-proxy';
import {
  assertCanEnforceEgressAllowList,
  assertEgressFilterLibraryHash,
  buildEgressFilterEnv,
  buildTourbillonBwrapArgs,
  egressProxySocketPath,
  ensureEgressLandlockLibrary,
  getEgressLibDir,
  getEgressRuntimeDir,
  hashEgressRunId,
  hashFileSha256,
  resolveEgressSocketRoot,
  UNIX_SOCKET_PATH_MAX,
  landlockNetAvailable,
  probeLandlockAbi,
  resolveEgressBwrapBinds,
  seccompFilterSupported,
} from './egress-enforcement';

const filterReady = landlockNetAvailable() && seccompFilterSupported();

describe('assertCanEnforceEgressAllowList', () => {
  it('does not throw for legacy allowNetwork (undefined list)', () => {
    assert.doesNotThrow(() => assertCanEnforceEgressAllowList('none', undefined));
    assert.doesNotThrow(() => assertCanEnforceEgressAllowList('bwrap', undefined));
  });

  it('allows empty list with native isolation without Landlock', () => {
    assert.doesNotThrow(() => assertCanEnforceEgressAllowList('bwrap', []));
    assert.doesNotThrow(() => assertCanEnforceEgressAllowList('seatbelt', []));
  });

  it('allows isolation=none empty list when Landlock+seccomp are available', () => {
    if (!filterReady) {
      assert.throws(
        () => assertCanEnforceEgressAllowList('none', []),
        /Cannot enforce empty egress allow-list/,
      );
      return;
    }
    assert.doesNotThrow(() => assertCanEnforceEgressAllowList('none', []));
  });

  it('refuses isolation=none with a non-empty list (same-port hole)', () => {
    assert.throws(
      () => assertCanEnforceEgressAllowList('none', ['api.example.com']),
      /isolation=none/,
    );
  });

  it('refuses isolation=seatbelt with a non-empty list', () => {
    assert.throws(
      () => assertCanEnforceEgressAllowList('seatbelt', ['api.example.com']),
      /isolation=seatbelt/,
    );
  });
});

describe('egress filter artifacts', () => {
  it('compiles the filter outside /tmp into the lib dir', () => {
    const lib = ensureEgressLandlockLibrary();
    assert.ok(lib.startsWith(getEgressLibDir()), lib);
    assert.ok(!lib.includes('/tmp/'), lib);
  });

  it('refuses a tampered filter library', () => {
    const lib = ensureEgressLandlockLibrary();
    const expected = hashFileSha256(lib);
    const bogus = join(tmpdir(), `tourbillon-tampered-${process.pid}.so`);
    copyFileSync(lib, bogus);
    chmodSync(bogus, 0o644);
    writeFileSync(bogus, 'not-a-real-filter');
    assert.throws(
      () => assertEgressFilterLibraryHash(bogus, expected),
      /hash mismatch/,
    );
    assert.doesNotThrow(() => assertEgressFilterLibraryHash(lib, expected));
  });

  it('probes Landlock ABI on this host', () => {
    const abi = probeLandlockAbi();
    if (process.platform === 'linux') {
      assert.ok(abi === null || abi >= 1);
    } else {
      assert.equal(abi, null);
    }
  });
});

function rwBindSources(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bind' && args[i + 1]) {
      out.push(args[i + 1]);
    }
  }
  return out;
}

function roBindSources(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ro-bind' && args[i + 1]) {
      out.push(args[i + 1]);
    }
  }
  return out;
}

describe('bwrap bind policy', () => {
  it('empty list binds the filter read-only and no socket / runtime dir', () => {
    const lib = ensureEgressLandlockLibrary();
    const binds = resolveEgressBwrapBinds({});
    assert.deepEqual(binds.extraRoBinds, [lib]);
    assert.deepEqual(binds.extraRwBinds, []);
    const ws = join(tmpdir(), `tourbillon-ws-empty-${process.pid}`);
    mkdirSync(ws, { recursive: true });
    const args = buildTourbillonBwrapArgs({
      workspacePath: ws,
      allowNetwork: false,
      extraRoBinds: binds.extraRoBinds,
      extraRwBinds: binds.extraRwBinds,
    });
    assert.ok(roBindSources(args).includes(lib), args.join(' '));
    assert.ok(!args.includes('/sys'), 'do not bind host /sys into the sandbox');
    for (const src of rwBindSources(args)) {
      assert.ok(
        !src.startsWith(getEgressRuntimeDir()),
        `empty list must not RW-bind runtime paths: ${src}`,
      );
    }
  });

  it('non-empty list binds only this run socket, not the shared runtime dir', () => {
    const socketPath = egressProxySocketPath('co-bind', 'run1');
    writeFileSync(socketPath, '');
    const binds = resolveEgressBwrapBinds({ proxySocketPath: socketPath });
    assert.deepEqual(binds.extraRwBinds, [socketPath]);
    assert.ok(!binds.extraRwBinds.includes(getEgressRuntimeDir()));
    const ws = join(tmpdir(), `tourbillon-ws-list-${process.pid}`);
    mkdirSync(ws, { recursive: true });
    const args = buildTourbillonBwrapArgs({
      workspacePath: ws,
      allowNetwork: false,
      extraRoBinds: binds.extraRoBinds,
      extraRwBinds: binds.extraRwBinds,
    });
    const rw = rwBindSources(args);
    assert.ok(rw.includes(socketPath), args.join(' '));
    assert.ok(!rw.includes(getEgressRuntimeDir()));
    assert.ok(!rw.includes(getEgressLibDir()));
    assert.ok(!rw.some((src) => src !== socketPath && src.startsWith(getEgressRuntimeDir())));
  });
});

describe('egress proxy socket identity', () => {
  it('hashes the full run id so UUID tasks and allow-lists do not collide', () => {
    const company = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const taskA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const taskB = 'bbbbcccc-cccc-4ccc-8ccc-cccccccccccc';
    const truncatedA = `${company}-${taskA}`.slice(0, 40);
    const truncatedB = `${company}-${taskB}`.slice(0, 40);
    assert.equal(truncatedA, truncatedB);

    assert.notEqual(
      hashEgressRunId({ companyId: company, taskId: taskA, allowList: ['example.com'] }),
      hashEgressRunId({ companyId: company, taskId: taskB, allowList: ['example.com'] }),
    );
    assert.notEqual(
      hashEgressRunId({ companyId: company, taskId: taskA, allowList: ['example.com'] }),
      hashEgressRunId({ companyId: company, taskId: taskA, allowList: ['example.org'] }),
    );

    const pathA = egressProxySocketPath(company, taskA, ['example.com']);
    const pathB = egressProxySocketPath(company, taskB, ['example.com']);
    assert.notEqual(pathA, pathB);
    assert.ok(Buffer.byteLength(pathA, 'utf8') <= UNIX_SOCKET_PATH_MAX);
    assert.match(pathA, /\.sock$/);
  });

  it('includes a unique run id so same company+task+list do not share a socket', () => {
    const company = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const task = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const list = ['example.com'];
    const a = hashEgressRunId({ companyId: company, taskId: task, allowList: list, runId: 'run-1' });
    const b = hashEgressRunId({ companyId: company, taskId: task, allowList: list, runId: 'run-2' });
    assert.notEqual(a, b);
    assert.notEqual(
      egressProxySocketPath(company, task, list, { runId: 'run-1' }),
      egressProxySocketPath(company, task, list, { runId: 'run-2' }),
    );
  });

  it('refuses a symlink socket root', () => {
    const tmp = join(tmpdir(), `tb-egress-root-${process.pid}`);
    const real = join(tmp, 'real');
    const link = join(tmp, 'link');
    mkdirSync(real, { recursive: true, mode: 0o700 });
    symlinkSync(real, link);
    assert.throws(
      () => resolveEgressSocketRoot(link),
      /symlink|0700|Refusing to start/i,
    );
  });

  it('refuses an overlong path instead of truncating', () => {
    const longRoot = join('/tmp', 'r'.repeat(90));
    assert.throws(
      () => egressProxySocketPath('co', 'task', ['h'], { socketRoot: longRoot }),
      /107/,
    );
  });
});

describe('Landlock + seccomp enforcement', () => {
  it('empty allow-list blocks TCP, UDP, and AF_UNIX', { skip: !filterReady }, () => {
    const env = buildEgressFilterEnv({});
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
        const net = require('net');
        const dgram = require('dgram');
        const tcp = new Promise((resolve) => {
          const s = net.connect({ host: '1.1.1.1', port: 53 }, () => { s.destroy(); resolve('tcp-ok'); });
          s.on('error', (e) => resolve(e.code || e.message));
        });
        const udp = new Promise((resolve) => {
          const s = dgram.createSocket('udp4');
          s.on('error', (e) => { try { s.close(); } catch {} resolve(e.code || e.message); });
          try {
            s.send(Buffer.from('x'), 53, '8.8.8.8', (err) => {
              if (err) { try { s.close(); } catch {} resolve(err.code || err.message); return; }
              s.close();
              resolve('udp-ok');
            });
          } catch (e) {
            resolve(e.code || e.message);
          }
        });
        const unix = new Promise((resolve) => {
          const s = net.connect({ path: '/tmp/tourbillon-no-such.sock' });
          s.on('connect', () => { s.destroy(); resolve('unix-ok'); });
          s.on('error', (e) => resolve(e.code || e.message));
        });
        Promise.all([tcp, udp, unix]).then(([t, u, x]) => {
          process.stdout.write(JSON.stringify({ tcp: t, udp: u, unix: x }));
          const tcpBlocked = t !== 'tcp-ok';
          const udpBlocked = u !== 'udp-ok';
          const unixBlocked = x !== 'unix-ok';
          process.exit(tcpBlocked && udpBlocked && unixBlocked ? 0 : 1);
        });
        `,
      ],
        { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10_000 },
      );
    assert.equal(result.status, 0, `empty list must block TCP+UDP+AF_UNIX: ${result.stdout} ${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as { tcp: string; udp: string; unix: string };
    assert.notEqual(parsed.tcp, 'tcp-ok');
    assert.notEqual(parsed.udp, 'udp-ok');
    assert.notEqual(parsed.unix, 'unix-ok');
  });

  it('proxy helper forwards loopback HTTP and blocks TCP/53', { skip: !filterReady }, async () => {
    const origin = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('via-proxy');
    });
    const originPort = await new Promise<number>((resolve) => {
      origin.listen(0, '127.0.0.1', () => resolve((origin.address() as { port: number }).port));
    });
    const proxy = new EgressProxy({ allowList: ['127.0.0.1'], companyId: 'co-filter' });
    const socketPath = egressProxySocketPath('co-filter', 't1');
    await proxy.start({ socketPath });

    try {
      const env = buildEgressFilterEnv({ proxySocketPath: socketPath });
      const script = `
        const { spawnSync } = require('child_process');
        const net = require('net');
        const proxyPort = ${JSON.stringify(env.TOURBILLON_EGRESS_PROXY_PORT)};
        function tryConnect(host, port) {
          return new Promise((resolve) => {
            const s = net.connect({ host, port, family: 4 }, () => { s.end(); resolve('ok'); });
            s.setTimeout(800, () => { s.destroy(); resolve('timeout'); });
            s.on('error', (e) => resolve(e.code || e.message));
          });
        }
        function proxyGet(url) {
          const r = spawnSync('curl', ['-4', '-sS', '-D', '-', '--max-time', '5', '-x', 'http://127.0.0.1:' + proxyPort, url], { encoding: 'utf8' });
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        }
        (async () => {
          const allowed = proxyGet('http://127.0.0.1:${originPort}/');
          const deniedHost = proxyGet('http://example.com/');
          const dns53 = await tryConnect('1.1.1.1', 53);
          const dnsGoogle = await tryConnect('8.8.4.4', 53);
          process.stdout.write(JSON.stringify({ allowed, deniedHost, dns53, dnsGoogle }));
          const ok = allowed && allowed.stdout && allowed.stdout.includes('via-proxy')
            && deniedHost && /403/.test(deniedHost.stdout + deniedHost.stderr)
            && dns53 !== 'ok' && dnsGoogle !== 'ok';
          process.exit(ok ? 0 : 1);
        })();
      `;
      /* spawn (not spawnSync): the unix proxy lives in this process's event loop. */
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], {
          env: { ...process.env, ...env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', reject);
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        child.on('close', (status) => {
          clearTimeout(timer);
          resolve({ status, stdout, stderr });
        });
      });
      assert.equal(
        result.status,
        0,
        `proxy filter failed: ${result.stdout} ${result.stderr}`,
      );
    } finally {
      await proxy.stop();
      origin.close();
    }
  });
});
