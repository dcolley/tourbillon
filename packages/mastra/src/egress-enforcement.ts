import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxIsolation } from '@tourbillon/shared';

const LANDLOCK_SOURCE = join(__dirname, 'native', 'tourbillon-egress-landlock.c');

let cachedAbi: number | null | undefined;
let cachedLibPath: string | undefined;

/** Highest Landlock ABI, or null when unavailable. Network rules need ABI 4+. */
export function probeLandlockAbi(): number | null {
  if (cachedAbi !== undefined) return cachedAbi;
  if (process.platform !== 'linux') {
    cachedAbi = null;
    return cachedAbi;
  }
  try {
    const src = [
      '#define _GNU_SOURCE',
      '#include <stdio.h>',
      '#include <unistd.h>',
      '#include <sys/syscall.h>',
      '#ifndef __NR_landlock_create_ruleset',
      '#define __NR_landlock_create_ruleset 444',
      '#endif',
      'int main(void) {',
      '  long abi = syscall(__NR_landlock_create_ruleset, (void*)0, 0, 1);',
      '  if (abi < 0) return 1;',
      '  printf("%ld\\n", abi);',
      '  return 0;',
      '}',
      '',
    ].join('\n');
    const dir = join(tmpdir(), 'tourbillon-egress-landlock');
    mkdirSync(dir, { recursive: true });
    const hash = createHash('sha256').update(src).digest('hex').slice(0, 12);
    const bin = join(dir, `abi-probe-${hash}`);
    if (!existsSync(bin)) {
      writeFileSync(`${bin}.c`, src);
      execFileSync('gcc', ['-O1', '-o', bin, `${bin}.c`], { stdio: 'pipe' });
    }
    const out = execFileSync(bin, { encoding: 'utf8' }).trim();
    const abi = parseInt(out, 10);
    cachedAbi = Number.isFinite(abi) ? abi : null;
  } catch {
    cachedAbi = null;
  }
  return cachedAbi;
}

export function landlockNetAvailable(): boolean {
  const abi = probeLandlockAbi();
  return abi !== null && abi >= 4;
}

/** Compile (or reuse) the LD_PRELOAD Landlock filter. */
export function ensureEgressLandlockLibrary(): string {
  if (cachedLibPath && existsSync(cachedLibPath)) return cachedLibPath;
  if (!existsSync(LANDLOCK_SOURCE)) {
    throw new Error(`Landlock filter source missing: ${LANDLOCK_SOURCE}`);
  }
  const source = readFileSync(LANDLOCK_SOURCE);
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), 'tourbillon-egress-landlock');
  mkdirSync(dir, { recursive: true });
  const lib = join(dir, `tourbillon-egress-landlock-${hash}.so`);
  if (!existsSync(lib)) {
    try {
      execFileSync('gcc', ['-shared', '-fPIC', '-O2', '-o', lib, LANDLOCK_SOURCE], { stdio: 'pipe' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to compile egress Landlock filter (gcc required): ${message}`);
    }
  }
  cachedLibPath = lib;
  return lib;
}

export function buildEgressFilterEnv(options: {
  proxyPort?: number;
  extra?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const lib = ensureEgressLandlockLibrary();
  const env: NodeJS.ProcessEnv = {
    ...options.extra,
    LD_PRELOAD: lib,
    TOURBILLON_EGRESS_ENFORCE: '1',
  };
  if (options.proxyPort !== undefined) {
    env.TOURBILLON_EGRESS_PROXY_PORT = String(options.proxyPort);
    const proxyUrl = `http://127.0.0.1:${options.proxyPort}`;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.ALL_PROXY = proxyUrl;
    env.all_proxy = proxyUrl;
  }
  return env;
}

/**
 * An allow-list (including empty) requires a real enforcement backend.
 * Linux Landlock ABI 4+ is the no-root path. isolation=none is allowed only
 * when Landlock can apply. Native isolation can still OS-block an empty list.
 */
export function assertCanEnforceEgressAllowList(
  isolation: SandboxIsolation,
  egressAllowList: string[] | undefined,
): void {
  if (egressAllowList === undefined) return;

  const empty = egressAllowList.length === 0;
  const native = isolation === 'seatbelt' || isolation === 'bwrap';

  if (empty && native) {
    return;
  }

  if (!landlockNetAvailable()) {
    throw new Error(
      empty
        ? `Cannot enforce empty egress allow-list with isolation=${isolation} ` +
          '(no Linux Landlock network ABI 4+). Use isolation=bwrap or isolation=seatbelt, ' +
          'or run on Linux 6.7+ with Landlock.'
        : 'Cannot enforce egress allow-list destinations without Linux Landlock (ABI 4+). ' +
          'iptables/netns would require root and is not enabled. ' +
          'Refusing to start the sandbox so an allow-list is never a no-op.',
    );
  }
}

export function sandboxDevNullPaths(): string[] {
  return ['/dev/null'];
}
