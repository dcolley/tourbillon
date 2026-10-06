import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getExecutionWorkspaceRoot, type SandboxIsolation } from '@tourbillon/shared';

const LANDLOCK_SOURCE = join(__dirname, 'native', 'tourbillon-egress-landlock.c');

/** Loopback port advertised as HTTP_PROXY; the LD_PRELOAD helper forwards to the unix proxy. */
export const EGRESS_PROXY_LOOPBACK_PORT = 17999;

const DEFAULT_READONLY_BINDS = [
  '/usr',
  '/lib',
  '/lib64',
  '/bin',
  '/sbin',
  '/etc/alternatives',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/passwd',
  '/etc/group',
  '/etc/nsswitch.conf',
  '/etc/ld.so.cache',
  '/etc/localtime',
];

let cachedAbi: number | null | undefined;
let cachedLibPath: string | undefined;

export function getEgressRuntimeDir(): string {
  const dir = join(getExecutionWorkspaceRoot(), '.runtime');
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
    const dir = getEgressRuntimeDir();
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

export function seccompFilterSupported(): boolean {
  return process.platform === 'linux' && process.arch === 'x64';
}

/** Compile (or reuse) the LD_PRELOAD filter into the execution runtime dir — not /tmp. */
export function ensureEgressLandlockLibrary(): string {
  if (cachedLibPath && existsSync(cachedLibPath)) return cachedLibPath;
  if (!existsSync(LANDLOCK_SOURCE)) {
    throw new Error(`Egress filter source missing: ${LANDLOCK_SOURCE}`);
  }
  const source = readFileSync(LANDLOCK_SOURCE);
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const dir = getEgressRuntimeDir();
  const lib = join(dir, `tourbillon-egress-filter-${hash}.so`);
  if (!existsSync(lib)) {
    try {
      execFileSync(
        'gcc',
        ['-shared', '-fPIC', '-O2', '-pthread', '-o', lib, LANDLOCK_SOURCE, '-ldl'],
        { stdio: 'pipe' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to compile egress filter (gcc required): ${message}`);
    }
  }
  cachedLibPath = lib;
  return lib;
}

export function egressProxySocketPath(companyId: string, taskId?: string): string {
  const safe = `${companyId}-${taskId ?? 'idle'}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return join(getEgressRuntimeDir(), `proxy-${safe}.sock`);
}

export function buildEgressFilterEnv(options: {
  proxySocketPath?: string;
  proxyPort?: number;
  extra?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const lib = ensureEgressLandlockLibrary();
  const env: NodeJS.ProcessEnv = {
    ...options.extra,
    LD_PRELOAD: lib,
    TOURBILLON_EGRESS_ENFORCE: '1',
    TOURBILLON_EGRESS_MODE: options.proxySocketPath ? 'proxy' : 'deny',
  };
  if (options.proxySocketPath) {
    env.TOURBILLON_EGRESS_PROXY_SOCKET = options.proxySocketPath;
    env.TOURBILLON_EGRESS_PROXY_PORT = String(options.proxyPort ?? EGRESS_PROXY_LOOPBACK_PORT);
    const proxyUrl = `http://127.0.0.1:${EGRESS_PROXY_LOOPBACK_PORT}`;
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
 * isolation=none needs Landlock + seccomp (x86_64). Native isolation can
 * OS-block an empty list (`--unshare-net`). A non-empty list on none also
 * needs the unix-socket remap filter.
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

  if (!empty && isolation === 'none') {
    throw new Error(
      'Cannot enforce a non-empty egress allow-list with isolation=none: ' +
        'Landlock is port-based, so a TCP helper port would be reachable on any IP. ' +
        'Use isolation=bwrap (unshare-net + unix-socket proxy) or isolation=seatbelt.',
    );
  }

  if (!landlockNetAvailable() || !seccompFilterSupported()) {
    throw new Error(
      empty
        ? `Cannot enforce empty egress allow-list with isolation=${isolation} ` +
          '(UDP/TCP would leak). Need Linux Landlock ABI 4+ and x86_64 seccomp, ' +
          'or isolation=bwrap/seatbelt. Refusing to start.'
        : 'Cannot enforce egress allow-list destinations without Linux Landlock (ABI 4+), ' +
          'seccomp, and bwrap --unshare-net + unix-socket proxy. Refusing to start.',
    );
  }
}

/**
 * Full bwrap argv (replaces Mastra defaults) so we can add `--dev /dev`.
 * When `allowNetwork` is false, `--unshare-net` is included.
 */
export function buildTourbillonBwrapArgs(options: {
  workspacePath: string;
  allowNetwork: boolean;
  extraRoBinds?: string[];
  extraRwBinds?: string[];
}): string[] {
  const args: string[] = [
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
  ];
  if (!options.allowNetwork) {
    args.push('--unshare-net');
  }
  args.push('--proc', '/proc');
  args.push('--dev', '/dev');
  args.push('--tmpfs', '/tmp');

  for (const path of DEFAULT_READONLY_BINDS) {
    args.push('--ro-bind-try', path, path);
  }
  for (const path of options.extraRoBinds ?? []) {
    if (path && existsSync(path)) {
      args.push('--ro-bind', path, path);
    }
  }
  for (const path of options.extraRwBinds ?? []) {
    if (path && existsSync(path)) {
      args.push('--bind', path, path);
    }
  }

  const nodeDir = dirname(process.execPath);
  if (!DEFAULT_READONLY_BINDS.some((p) => nodeDir === p || nodeDir.startsWith(`${p}/`))) {
    args.push('--ro-bind-try', nodeDir, nodeDir);
  }
  args.push('--ro-bind-try', '/opt', '/opt');
  args.push('--ro-bind-try', '/snap', '/snap');

  args.push('--bind', options.workspacePath, options.workspacePath);
  args.push('--chdir', options.workspacePath);
  args.push('--die-with-parent');
  return args;
}
