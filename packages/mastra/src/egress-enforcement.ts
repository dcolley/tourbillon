import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** sockaddr_un.sun_path including the trailing NUL (Linux). */
export const UNIX_SOCKET_PATH_MAX = 107;

const DEFAULT_SOCKET_ROOTS = [
  '/run/tourbillon/egress',
  `/run/user/${process.getuid?.() ?? 1000}/tourbillon-egress`,
  '/tmp/tourbillon-egress',
];

let cachedAbi: number | null | undefined;
let cachedLibPath: string | undefined;
let cachedLibSha256: string | undefined;

/** Host-only runtime root. Never bind this directory into a sandbox. */
export function getEgressRuntimeDir(): string {
  const dir = join(getExecutionWorkspaceRoot(), '.runtime');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

/** Compiled filter libraries. Bind individual `.so` files read-only, never this dir RW. */
export function getEgressLibDir(): string {
  const dir = join(getEgressRuntimeDir(), 'lib');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

function inspectSocketRoot(dir: string): 'ok' | 'unsafe' | 'missing' {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return 'unsafe';
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      return 'unsafe';
    }
    if ((st.mode & 0o777) !== 0o700) {
      try {
        chmodSync(dir, 0o700);
      } catch {
        return 'unsafe';
      }
      const st2 = lstatSync(dir);
      if (st2.isSymbolicLink() || !st2.isDirectory() || (st2.mode & 0o777) !== 0o700) {
        return 'unsafe';
      }
      if (typeof process.getuid === 'function' && st2.uid !== process.getuid()) {
        return 'unsafe';
      }
    }
    return 'ok';
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    return code === 'ENOENT' ? 'missing' : 'unsafe';
  }
}

function tryCreateSocketRoot(dir: string): boolean {
  try {
    const before = inspectSocketRoot(dir);
    if (before === 'unsafe') {
      return false;
    }
    if (before === 'missing') {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (inspectSocketRoot(dir) !== 'ok') {
      return false;
    }
    const probe = join(dir, `.w-${process.pid}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Short fixed root for unix proxy sockets. Never the execution-workspace tree. */
export function resolveEgressSocketRoot(override?: string): string {
  const candidates = [
    override,
    process.env.TOURBILLON_EGRESS_SOCKET_ROOT,
    ...DEFAULT_SOCKET_ROOTS,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  for (const dir of candidates) {
    if (tryCreateSocketRoot(dir)) {
      return dir;
    }
    if (override || process.env.TOURBILLON_EGRESS_SOCKET_ROOT === dir) {
      throw new Error(
        `Cannot use egress socket root ${dir}: must be a 0700 directory we own, not a symlink. Refusing to start.`,
      );
    }
  }
  throw new Error(
    'Cannot create a short egress socket root ' +
      '(/run/tourbillon/egress, /run/user/$UID/tourbillon-egress, or /tmp/tourbillon-egress). ' +
      'Set TOURBILLON_EGRESS_SOCKET_ROOT. Refusing to start.',
  );
}

export function assertUnixSocketPathLength(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  if (bytes > UNIX_SOCKET_PATH_MAX) {
    throw new Error(
      `Egress proxy unix socket path is ${bytes} bytes (max ${UNIX_SOCKET_PATH_MAX}). ` +
        'Refusing to start; never truncating. Use a shorter TOURBILLON_EGRESS_SOCKET_ROOT ' +
        `(default /run/tourbillon/egress). Path: ${socketPath}`,
    );
  }
}

/** Stable hash of the full run identity — never a truncated companyId-taskId. */
export function hashEgressRunId(options: {
  companyId: string;
  taskId?: string;
  allowList?: string[];
  /** Unique per sandbox instance so teardown cannot unlink another run's socket. */
  runId?: string;
}): string {
  const identity = [
    options.companyId,
    options.taskId ?? 'idle',
    (options.allowList ?? []).slice().sort().join('\n'),
    options.runId ?? '',
  ].join('\0');
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

export function hashFileSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function assertEgressFilterLibraryHash(libPath: string, expectedSha256: string): void {
  if (!existsSync(libPath) || hashFileSha256(libPath) !== expectedSha256) {
    throw new Error('Egress filter library hash mismatch; refusing to start');
  }
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

function compileFilterLibrary(dest: string): void {
  try {
    execFileSync(
      'gcc',
      ['-shared', '-fPIC', '-O2', '-pthread', '-o', dest, LANDLOCK_SOURCE, '-ldl'],
      { stdio: 'pipe' },
    );
    chmodSync(dest, 0o444);
  } catch (err) {
    try {
      unlinkSync(dest);
    } catch {
      /* tmp may not exist */
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to compile egress filter (gcc required): ${message}`);
  }
}

/**
 * Compile (or reuse) the LD_PRELOAD filter into the lib dir — not /tmp.
 * Always hash-checks the on-disk `.so` before returning; refuses if tampered.
 */
export function ensureEgressLandlockLibrary(): string {
  if (!existsSync(LANDLOCK_SOURCE)) {
    throw new Error(`Egress filter source missing: ${LANDLOCK_SOURCE}`);
  }
  const source = readFileSync(LANDLOCK_SOURCE);
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const lib = join(getEgressLibDir(), `tourbillon-egress-filter-${sourceHash.slice(0, 16)}.so`);

  if (cachedLibPath === lib && cachedLibSha256) {
    assertEgressFilterLibraryHash(lib, cachedLibSha256);
    return lib;
  }

  const tmp = `${lib}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  compileFilterLibrary(tmp);
  const freshHash = hashFileSha256(tmp);

  if (existsSync(lib)) {
    try {
      assertEgressFilterLibraryHash(lib, freshHash);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    chmodSync(lib, 0o444);
  } else {
    try {
      renameSync(tmp, lib);
    } catch {
      if (!existsSync(lib)) {
        throw new Error('Failed to publish egress filter library');
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      assertEgressFilterLibraryHash(lib, freshHash);
    }
    chmodSync(lib, 0o444);
  }

  cachedLibPath = lib;
  cachedLibSha256 = freshHash;
  return lib;
}

/**
 * Per-run unix socket: `/run/tourbillon/egress/<hash>.sock`.
 * Hash covers companyId, taskId, allow-list, and unique run id (never truncated names).
 */
export function egressProxySocketPath(
  companyId: string,
  taskId?: string,
  allowList: string[] = [],
  options?: { socketRoot?: string; runId?: string },
): string {
  const root = resolveEgressSocketRoot(options?.socketRoot);
  const hash = hashEgressRunId({
    companyId,
    taskId,
    allowList,
    runId: options?.runId,
  });
  const socketPath = join(root, `${hash}.sock`);
  assertUnixSocketPathLength(socketPath);
  return socketPath;
}

/**
 * Binds for one sandbox: the filter `.so` read-only, and (only when a list
 * is non-empty) this run's proxy socket. Never the shared runtime dir.
 */
export function resolveEgressBwrapBinds(options: {
  proxySocketPath?: string;
}): { extraRoBinds: string[]; extraRwBinds: string[] } {
  const lib = ensureEgressLandlockLibrary();
  return {
    extraRoBinds: [lib],
    extraRwBinds: options.proxySocketPath ? [options.proxySocketPath] : [],
  };
}

export function buildEgressFilterEnv(options: {
  proxySocketPath?: string;
  proxyPort?: number;
  extra?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const lib = ensureEgressLandlockLibrary();
  // A child-process env map, so NODE_ENV may legitimately be absent (`extra` is optional).
  // Next's global types make ProcessEnv.NODE_ENV required when apps/web type-checks this file,
  // so assert the map's shape, as execution-workspace.ts does for sandboxEnv. Type-only.
  const env = {
    ...options.extra,
    LD_PRELOAD: lib,
    TOURBILLON_EGRESS_ENFORCE: '1',
    TOURBILLON_EGRESS_MODE: options.proxySocketPath ? 'proxy' : 'deny',
  } as NodeJS.ProcessEnv;
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
 * Empty + bwrap/seatbelt: OS network off (no proxy socket). Empty + none:
 * Landlock+seccomp. Non-empty: isolation=bwrap only (seatbelt and none refuse).
 */
export function assertCanEnforceEgressAllowList(
  isolation: SandboxIsolation,
  egressAllowList: string[] | undefined,
): void {
  if (egressAllowList === undefined) return;

  const empty = egressAllowList.length === 0;

  if (!empty && isolation !== 'bwrap') {
    throw new Error(
      `Cannot enforce a non-empty egress allow-list with isolation=${isolation}. ` +
        'Only isolation=bwrap binds a per-run unix-socket proxy and unshares the netns. ' +
        'isolation=none and isolation=seatbelt are refused.',
    );
  }

  if (empty && (isolation === 'bwrap' || isolation === 'seatbelt')) {
    return;
  }

  if (!landlockNetAvailable() || !seccompFilterSupported()) {
    throw new Error(
      empty
        ? `Cannot enforce empty egress allow-list with isolation=${isolation} ` +
          '(UDP/TCP would leak). Need Linux Landlock ABI 4+ and x86_64 seccomp, ' +
          'or isolation=bwrap/seatbelt. Refusing to start.'
        : 'Cannot enforce egress allow-list destinations without Linux Landlock (ABI 4+), ' +
          'seccomp, and bwrap --unshare-net + a per-run unix-socket proxy. Refusing to start.',
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
