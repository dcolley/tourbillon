import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, chmodSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

/**
 * The compiled filter lives under the execution workspace root
 * (`<workspaceRoot>/.runtime/lib`), which is inside the repo checkout in the normal
 * setup. When the checkout itself lives under /tmp, the "outside /tmp" assertion is
 * environmental noise: the guard is correct (compilation must never land in
 * world-writable /tmp) but cannot be observed from a /tmp checkout.
 *
 * Exported for the S261-S1 pins below (node:test imports this module directly).
 */
export function libDirUnderTmp(): boolean {
  try {
    // Resolve symlinks so /tmp -> /private/tmp (macOS) and bind-mount aliases are caught.
    const runtimeDir = realpathSync(getEgressRuntimeDir());
    return runtimeDir === '/tmp' || runtimeDir.startsWith(`${sep}tmp${sep}`);
  } catch {
    return false;
  }
}

/** Set/restore env around one assertion block (host env must not leak into branches). */
function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) saved.set(key, process.env[key]);
  try {
    Object.assign(process.env, vars);
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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
  it('compiles the filter outside /tmp into the lib dir', (t) => {
    if (libDirUnderTmp()) {
      // Environmental: the runtime dir inherits the checkout location, so from a
      // checkout under /tmp this assertion can never observe a non-/tmp path.
      t.skip('skipped: repo checkout (and thus the egress runtime dir) is under /tmp');
      return;
    }
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

describe('/tmp skip guard (S261-S1)', () => {
  // Pins for the environmental skip in "compiles the filter outside /tmp into the lib
  // dir". Without these, an "always-skip" mutant (guard returns true unconditionally)
  // would survive: the compile test itself silently stops asserting anything. These
  // tests drive the guard directly under controlled EXECUTION_WORKSPACE_ROOT values so
  // it must skip ONLY for a genuine /tmp runtime dir and must RUN otherwise.

  const scratchDirs: string[] = [];
  function scratchRoot(label: string): string {
    // Literal /tmp, NOT tmpdir(): the guard matches the /tmp prefix specifically and
    // TMPDIR can point elsewhere (e.g. a scratch dir under $HOME) without changing
    // what counts as the world-writable /tmp for this guard.
    const dir = join('/tmp', `tourbillon-s261-s1-${label}-${process.pid}`);
    scratchDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  function outsideTmpRoot(label: string): string {
    // S267-S1: an "outside /tmp" fixture must NOT be derived from the checkout
    // location — when the checkout itself lives under /tmp a sibling of src/ is
    // still under /tmp and the pin tests would assert nothing (or fail outright).
    // mkdtemp under /var/tmp (falling back to $HOME) is independent of where the
    // repo lives; cleaned up via scratchDirs.
    const bases = ['/var/tmp', homedir()];
    let lastError: unknown;
    for (const base of bases) {
      try {
        const dir = mkdtempSync(join(base, `tourbillon-s267-s1-${label}-`));
        scratchDirs.push(dir);
        return dir;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`cannot create non-/tmp fixture dir (${bases.join(', ')}): ${String(lastError)}`);
  }
  function cleanupScratch(): void {
    while (scratchDirs.length) {
      try {
        rmSync(scratchDirs.pop()!, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  it('skips when the runtime dir genuinely lives under /tmp', () => {
    try {
      withEnv({ EXECUTION_WORKSPACE_ROOT: scratchRoot('inside-tmp') }, () => {
        assert.equal(libDirUnderTmp(), true);
      });
    } finally {
      cleanupScratch();
    }
  });

  it('classifies literal runtime roots: /tmp true, /var/tmp and $HOME false', () => {
    // S267-S1: location-independent pin of the guard itself, driven by literal
    // EXECUTION_WORKSPACE_ROOT values. Sub-directories are created inside each
    // root so getEgressRuntimeDir()'s mkdir does not depend on write access to
    // the parent itself. An always-skip mutant fails on the /var/tmp and $HOME
    // cases regardless of where the checkout lives.
    try {
      for (const [root, expected] of [
        [join('/tmp', `tourbillon-s267-s1-literal-${process.pid}`), true],
        [join(outsideTmpRoot('vartmp'), 'runtime'), false],
        [join(outsideTmpRoot('home'), 'runtime'), false],
      ] as Array<[string, boolean]>) {
        withEnv({ EXECUTION_WORKSPACE_ROOT: root }, () => {
          assert.equal(libDirUnderTmp(), expected, `guard must report ${expected} for ${root}`);
        });
      }
    } finally {
      cleanupScratch();
    }
  });

  it('runs (does not skip) for a non-/tmp runtime dir', () => {
    // An always-skip mutant fails HERE: a genuine non-/tmp runtime dir must report
    // false so the compile assertion executes (see also the real-compile case
    // below). The fixture is created OUTSIDE the checkout (S267-S1) so this holds
    // even when the checkout itself lives under /tmp.
    const root = outsideTmpRoot('outside');
    try {
      withEnv({ EXECUTION_WORKSPACE_ROOT: root }, () => {
        assert.equal(libDirUnderTmp(), false);
      });
    } finally {
      cleanupScratch();
    }
  });

  it('resolves symlinks: a runtime dir symlinked into /tmp still counts as /tmp', () => {
    // An isAbsolute()-style mutant that inspects the raw path instead of realpathSync
    // would wrongly report false here (raw path outside /tmp, real target inside).
    // The raw-side fixture is created OUTSIDE the checkout (S267-S1) so the raw path
    // is genuinely non-/tmp even from a /tmp checkout — otherwise the mutant would
    // see /tmp raw and pass vacuously.
    const outside = outsideTmpRoot('link');
    const realInside = scratchRoot('link-target');
    const linkDir = join(outside, '.runtime');
    try {
      symlinkSync(realInside, linkDir);
      withEnv({ EXECUTION_WORKSPACE_ROOT: outside }, () => {
        assert.equal(libDirUnderTmp(), true);
      });
    } finally {
      cleanupScratch();
    }
  });

  it('the compile assertion itself runs on this host (runtime dir not under /tmp)', () => {
    // Guard must not over-skip in the default checkout: with the ambient
    // EXECUTION_WORKSPACE_ROOT (or its default), the compile test must be live —
    // it skips (GREEN, vacuous) or fails; it must not silently always skip.
    if (libDirUnderTmp()) {
      // This host's checkout genuinely lives under /tmp: the environmental skip is
      // correct here. The guard-logic pins above still ran and must not over-skip.
      return;
    }
    const lib = ensureEgressLandlockLibrary();
    assert.ok(lib.startsWith(getEgressLibDir()), lib);
    assert.ok(!lib.includes('/tmp/'), lib);
  });

  it('the skip branch stays wired to the guard (source pin)', () => {
    const src = readFileSync(fileURLToPath(new URL('./egress-enforcement.test.ts', import.meta.url)), 'utf8');
    const compileTest = src.slice(
      src.indexOf("it('compiles the filter outside /tmp into the lib dir'"),
      src.indexOf("it('refuses a tampered filter library'"),
    );
    assert.ok(compileTest.length > 0, 'compile test not found');
    // Exactly one skip, and it sits inside the libDirUnderTmp() guard.
    const skipCalls = compileTest.match(/t\.skip\(/g) ?? [];
    assert.equal(skipCalls.length, 1, 'compile test must contain exactly one t.skip()');
    const guardIdx = compileTest.indexOf('if (libDirUnderTmp())');
    assert.ok(guardIdx >= 0, 'compile test must gate on libDirUnderTmp()');
    assert.ok(
      skipCalls.length === 1 && compileTest.indexOf('t.skip(') > guardIdx,
      'the only t.skip() must live inside the libDirUnderTmp() guard',
    );
    assert.match(compileTest, /if \(libDirUnderTmp\(\)\) \{\s*(\/\/[^\n]*\n\s*)*t\.skip\(/); // guarded skip line, comments allowed
    assert.ok(
      compileTest.includes('ensureEgressLandlockLibrary()'),
      'compile assertion body must remain reachable',
    );
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
