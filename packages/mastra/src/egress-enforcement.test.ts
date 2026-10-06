import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { EgressProxy } from './egress-proxy';
import {
  assertCanEnforceEgressAllowList,
  buildEgressFilterEnv,
  egressProxySocketPath,
  ensureEgressLandlockLibrary,
  getEgressRuntimeDir,
  landlockNetAvailable,
  probeLandlockAbi,
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
});

describe('egress filter artifacts', () => {
  it('compiles the filter outside /tmp', () => {
    const lib = ensureEgressLandlockLibrary();
    assert.ok(lib.startsWith(getEgressRuntimeDir()), lib);
    assert.ok(!lib.includes('/tmp/'), lib);
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

describe('Landlock + seccomp enforcement', () => {
  it('empty allow-list blocks TCP and UDP', { skip: !filterReady }, () => {
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
        Promise.all([tcp, udp]).then(([t, u]) => {
          process.stdout.write(JSON.stringify({ tcp: t, udp: u }));
          const tcpBlocked = t !== 'tcp-ok';
          const udpBlocked = u !== 'udp-ok';
          process.exit(tcpBlocked && udpBlocked ? 0 : 1);
        });
        `,
      ],
        { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10_000 },
      );
    assert.equal(result.status, 0, `empty list must block TCP+UDP: ${result.stdout} ${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as { tcp: string; udp: string };
    assert.notEqual(parsed.tcp, 'tcp-ok');
    assert.notEqual(parsed.udp, 'udp-ok');
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
