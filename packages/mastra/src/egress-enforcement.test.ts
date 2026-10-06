import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  assertCanEnforceEgressAllowList,
  buildEgressFilterEnv,
  landlockNetAvailable,
  probeLandlockAbi,
} from './egress-enforcement';

describe('assertCanEnforceEgressAllowList', () => {
  it('does not throw for legacy allowNetwork (undefined list)', () => {
    assert.doesNotThrow(() => assertCanEnforceEgressAllowList('none', undefined));
    assert.doesNotThrow(() => assertCanEnforceEgressAllowList('bwrap', undefined));
  });

  it('allows empty list with native isolation without Landlock', () => {
    assert.doesNotThrow(() => assertCanEnforceEgressAllowList('bwrap', []));
    assert.doesNotThrow(() => assertCanEnforceEgressAllowList('seatbelt', []));
  });

  it('allows isolation=none when Landlock net is available', () => {
    if (!landlockNetAvailable()) {
      assert.throws(
        () => assertCanEnforceEgressAllowList('none', []),
        /Cannot enforce empty egress allow-list/,
      );
      return;
    }
    assert.doesNotThrow(() => assertCanEnforceEgressAllowList('none', []));
    assert.doesNotThrow(() => assertCanEnforceEgressAllowList('none', ['api.example.com']));
  });
});

describe('Landlock TCP enforcement', () => {
  it('probes Landlock ABI on this host', () => {
    const abi = probeLandlockAbi();
    if (process.platform === 'linux') {
      assert.ok(abi === null || abi >= 1);
    } else {
      assert.equal(abi, null);
    }
  });

  it('empty allow-list blocks TCP connect', { skip: !landlockNetAvailable() }, async () => {
    const listener = createServer();
    const livePort = await new Promise<number>((resolve) => {
      listener.listen(0, '127.0.0.1', () => resolve((listener.address() as AddressInfo).port));
    });
    try {
      const env = buildEgressFilterEnv({});
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `
          const net = require('net');
          const s = net.connect({ host: '127.0.0.1', port: ${livePort} }, () => process.exit(2));
          s.on('error', (e) => {
            const blocked = e.code === 'EACCES' || e.code === 'EPERM';
            process.stderr.write(String(e.code || e.message));
            process.exit(blocked ? 0 : 1);
          });
          setTimeout(() => process.exit(3), 2000);
          `,
        ],
        { env: { ...process.env, ...env }, encoding: 'utf8' },
      );
      assert.equal(
        result.status,
        0,
        `empty list must block TCP (status=${result.status} stderr=${result.stderr})`,
      );
    } finally {
      listener.close();
    }
  });

  it('non-empty list allows only the proxy port', { skip: !landlockNetAvailable() }, async () => {

    const allowed = createServer((_req, res) => {
      res.writeHead(200);
      res.end('proxy-ok');
    });
    const denied = createServer((_req, res) => {
      res.writeHead(200);
      res.end('should-not-connect');
    });

    const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });

    return Promise.all([listen(allowed), listen(denied)]).then(([allowedPort, deniedPort]) => {
      try {
        const env = buildEgressFilterEnv({ proxyPort: allowedPort });
        const script = `
          const net = require('net');
          function tryConnect(port) {
            return new Promise((resolve) => {
              const s = net.connect({ host: '127.0.0.1', port }, () => { s.end(); resolve('ok'); });
              s.on('error', (e) => resolve(e.code || e.message));
            });
          }
          (async () => {
            const allowed = await tryConnect(${allowedPort});
            const denied = await tryConnect(${deniedPort});
            process.stdout.write(JSON.stringify({ allowed, denied }));
            process.exit(allowed === 'ok' && denied !== 'ok' ? 0 : 1);
          })();
        `;
        const result = spawnSync(process.execPath, ['-e', script], {
          env: { ...process.env, ...env },
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, `landlock allow/deny failed: ${result.stdout} ${result.stderr}`);
        const parsed = JSON.parse(result.stdout) as { allowed: string; denied: string };
        assert.equal(parsed.allowed, 'ok', 'connect to proxy port must succeed');
        assert.notEqual(parsed.denied, 'ok', 'connect to any other port must fail');
      } finally {
        allowed.close();
        denied.close();
      }
    });
  });
});
