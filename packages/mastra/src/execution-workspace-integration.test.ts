import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { AddressInfo } from 'node:net';
import { describe, it, type TestContext } from 'node:test';
import { LocalSandbox } from '@mastra/core/workspace';
import { EgressProxy } from './egress-proxy';
import type { HostResolver } from './egress-private-ranges';
import {
  buildEgressFilterEnv,
  buildTourbillonBwrapArgs,
  egressProxySocketPath,
  getEgressRuntimeDir,
  landlockNetAvailable,
  resolveEgressBwrapBinds,
  seccompFilterSupported,
} from './egress-enforcement';

const filterReady = landlockNetAvailable() && seccompFilterSupported();

function bwrapAvailable(): boolean {
  try {
    execFileSync('bwrap', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('Sandbox DNS and /dev/null under filter + bwrap', () => {
  it('/dev/null is usable under bwrap --dev /dev + egress filter', { skip: !bwrapAvailable() || !filterReady }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tourbillon-bwrap-devnull-'));
    const env = buildEgressFilterEnv({});
    const binds = resolveEgressBwrapBinds({});
    const sandbox = new LocalSandbox({
      workingDirectory: cwd,
      isolation: 'bwrap',
      timeout: 20_000,
      env,
      nativeSandbox: {
        allowNetwork: false,
        bwrapArgs: buildTourbillonBwrapArgs({
          workspacePath: cwd,
          allowNetwork: false,
          extraRoBinds: binds.extraRoBinds,
          extraRwBinds: binds.extraRwBinds,
        }),
      },
    });
    await sandbox.start();
    try {
      const result = await sandbox.executeCommand?.('sh', [
        '-c',
        'test -e /dev/null && test -w /dev/null && echo proof >/dev/null && echo success',
      ]);
      assert.ok(result, 'executeCommand must be available');
      assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /success/);
    } finally {
      await sandbox.destroy();
    }
  });

  it('empty list cannot see another run’s proxy socket or the shared runtime dir', { skip: !bwrapAvailable() || !filterReady }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tourbillon-bwrap-empty-iso-'));
    const foreign = new EgressProxy({
      allowList: ['example.org'],
      companyId: 'co-foreign',
    });
    const foreignSocket = egressProxySocketPath('co-foreign', 'other');
    await foreign.start({ socketPath: foreignSocket });

    const planted = join(getEgressRuntimeDir(), 'planted-leak.sock');
    writeFileSync(planted, 'not-a-socket-but-visible-if-dir-bound');
    chmodSync(planted, 0o666);

    const env = buildEgressFilterEnv({});
    const binds = resolveEgressBwrapBinds({});
    assert.deepEqual(binds.extraRwBinds, []);

    const sandbox = new LocalSandbox({
      workingDirectory: cwd,
      isolation: 'bwrap',
      timeout: 20_000,
      env,
      nativeSandbox: {
        allowNetwork: false,
        bwrapArgs: buildTourbillonBwrapArgs({
          workspacePath: cwd,
          allowNetwork: false,
          extraRoBinds: binds.extraRoBinds,
          extraRwBinds: binds.extraRwBinds,
        }),
      },
    });
    await sandbox.start();
    try {
      const probe = await sandbox.executeCommand?.('sh', [
        '-c',
        `lib=${JSON.stringify(binds.extraRoBinds[0])}; test -e ${JSON.stringify(foreignSocket)} && echo saw-foreign; test -e ${JSON.stringify(planted)} && echo saw-runtime; test -e "$lib" && test ! -w "$lib" && echo so-readonly || echo so-missing-or-writable; echo done`,
      ]);
      assert.ok(probe);
      assert.equal(probe.exitCode, 0, `${probe.stderr}\n${probe.stdout}`);
      assert.doesNotMatch(probe.stdout, /saw-foreign/);
      assert.doesNotMatch(probe.stdout, /saw-runtime/);
      assert.match(probe.stdout, /so-readonly/);
    } finally {
      await sandbox.destroy();
      await foreign.stop();
    }
  });

  // S264-S3: the old version of this test depended on real DNS (and internet)
  // in the parent process: dns.lookup('example.com') inside EgressProxy plus
  // a live fetch of example.com, and failed on hosts without either. The
  // sandbox-facing guarantees (proxy-only egress, no TCP/53, no proxy skip)
  // do not depend on the internet at all, so the happy path now pins the
  // target to a local origin through the proxy's injected HostResolver
  // (same pattern as egress-proxy.test.ts, "resolve-then-pin"). never-allow.invalid
  // still gets 403 from the allow-list, and the resolver throws for any other
  // host so an accidental DNS round-trip would surface as 502 != 403.
  it('proxy pins allow-listed host to a local origin; sandbox cannot use TCP/53 or skip the proxy', { skip: !bwrapAvailable() || !filterReady }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tourbillon-bwrap-dns-'));
    const origin = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('tourbillon-origin-ok');
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const originPort = (origin.address() as AddressInfo).port;

    const resolveHost: HostResolver = async (host) => {
      if (host === 'example.com') return [{ address: '127.0.0.1', family: 4 }];
      throw new Error(`unexpected resolve for ${host} (allow-list must deny before DNS)`);
    };
    const proxy = new EgressProxy({
      // 127.0.0.1 as an exact-IP entry is the only way through the private-range
      // guard for the loopback pin (see hasPrivateOverride).
      allowList: ['example.com', '127.0.0.1'],
      companyId: 'co-bwrap',
      resolve: resolveHost,
    });
    const socketPath = egressProxySocketPath('co-bwrap', 'dns');
    await proxy.start({ socketPath });

    const env = buildEgressFilterEnv({ proxySocketPath: socketPath });
    const binds = resolveEgressBwrapBinds({ proxySocketPath: socketPath });
    assert.deepEqual(binds.extraRwBinds, [socketPath]);

    const sandbox = new LocalSandbox({
      workingDirectory: cwd,
      isolation: 'bwrap',
      timeout: 25_000,
      env,
      nativeSandbox: {
        allowNetwork: false,
        bwrapArgs: buildTourbillonBwrapArgs({
          workspacePath: cwd,
          allowNetwork: false,
          extraRoBinds: binds.extraRoBinds,
          extraRwBinds: binds.extraRwBinds,
        }),
      },
    });
    await sandbox.start();
    try {
      const viaProxy = await sandbox.executeCommand?.('sh', [
        '-c',
        `curl -sS -o /tmp/out -w "%{http_code}" --max-time 15 http://example.com:${originPort}/ && echo && cat /tmp/out | head -c 80`,
      ]);
      assert.ok(viaProxy);
      assert.equal(viaProxy.exitCode, 0, `curl via proxy failed: ${viaProxy.stderr}\n${viaProxy.stdout}`);
      assert.match(viaProxy.stdout, /^200/);
      assert.match(viaProxy.stdout, /tourbillon-origin-ok/);

      const dnsBypass = await sandbox.executeCommand?.('sh', [
        '-c',
        'python3 - <<\'PY\'\nimport socket,sys\nfor host,port in [("1.1.1.1",53),("8.8.4.4",53),("1.1.1.1",17999)]:\n    s=socket.socket(); s.settimeout(2)\n    try:\n        s.connect((host,port)); print("connected",host,port); sys.exit(2)\n    except Exception as e:\n        print(host,port,type(e).__name__)\n    finally:\n        s.close()\nprint("blocked")\nPY',
      ]);
      assert.ok(dnsBypass);
      assert.equal(dnsBypass.exitCode, 0, `DNS bypass check failed: ${dnsBypass.stderr}\n${dnsBypass.stdout}`);
      assert.match(dnsBypass.stdout, /blocked/);
      assert.doesNotMatch(dnsBypass.stdout, /connected/);

      const denied = await sandbox.executeCommand?.('sh', [
        '-c',
        'curl -sS -o /dev/null -w "%{http_code}" --max-time 8 http://never-allow.invalid/ || true',
      ]);
      assert.ok(denied);
      assert.match(denied.stdout, /403/);
    } finally {
      await sandbox.destroy();
      await proxy.stop();
      await new Promise<void>((resolve, reject) =>
        origin.close((err?: Error | null) => (err ? reject(err) : resolve())),
      );
    }
  });

  // Real-DNS leg kept as its own test, deterministically SKIPPED when the host
  // has no usable DNS (probe first; no DNS -> skip, never fail). Covers
  // defaultHostResolver end-to-end on gate machines where DNS works.
  it('proxy resolves a real hostname through system DNS', { skip: !bwrapAvailable() || !filterReady }, async (t: TestContext) => {
    try {
      await dnsLookup('example.com');
    } catch (err) {
      t.skip(`host has no usable DNS: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const cwd = mkdtempSync(join(tmpdir(), 'tourbillon-bwrap-realdns-'));
    const proxy = new EgressProxy({
      allowList: ['example.com'],
      companyId: 'co-bwrap-real',
    });
    const socketPath = egressProxySocketPath('co-bwrap-real', 'dns');
    await proxy.start({ socketPath });

    const env = buildEgressFilterEnv({ proxySocketPath: socketPath });
    const binds = resolveEgressBwrapBinds({ proxySocketPath: socketPath });

    const sandbox = new LocalSandbox({
      workingDirectory: cwd,
      isolation: 'bwrap',
      timeout: 25_000,
      env,
      nativeSandbox: {
        allowNetwork: false,
        bwrapArgs: buildTourbillonBwrapArgs({
          workspacePath: cwd,
          allowNetwork: false,
          extraRoBinds: binds.extraRoBinds,
          extraRwBinds: binds.extraRwBinds,
        }),
      },
    });
    await sandbox.start();
    try {
      const viaProxy = await sandbox.executeCommand?.('sh', [
        '-c',
        'curl -sS -o /tmp/out -w "%{http_code}" --max-time 15 http://example.com/ && echo && cat /tmp/out | head -c 80',
      ]);
      assert.ok(viaProxy);
      assert.equal(viaProxy.exitCode, 0, `curl via proxy failed: ${viaProxy.stderr}\n${viaProxy.stdout}`);
      assert.match(viaProxy.stdout, /^(20[0-9]|30[0-9])/);
    } finally {
      await sandbox.destroy();
      await proxy.stop();
    }
  });
});
