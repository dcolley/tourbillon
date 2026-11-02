/**
 * Ops seat inventory — meta.json SCHEMA 2 (Ops contract, 2026-10-31).
 *
 * Each live seat under the canonical host root carries a meta.json written by the Ops
 * `cc-ensure-seat` script. Schema 2 shape (LOCKED — schema 1 embedded the VNC password
 * inline and used array-form mounts; the parser refuses it):
 *
 *   {
 *     "schema": 2,
 *     "containerName": "cc-acme-ceo",
 *     "hostPort": 6901,
 *     "vncPasswordFile": "vnc_pw",          // sibling FILE, never the password itself
 *     "mounts": {                            // OBJECT form: host path -> container path
 *       "/opt/tourbillon-company-c1/data": "/data",
 *       "/opt/tourbillon-company-c1/home/ceo": "/home/kasm-user"
 *     }
 *   }
 *
 * The VNC password lives ONLY in the sibling `vnc_pw` file at mode 600 (owned by the
 * Ops user); it must never appear in meta.json, logs, or the DB. Slice 1 parses and
 * validates this shape only — reading/parsing is side-effect free, so it is safe to
 * ship before the Ops scripts exist.
 */
import {
  assertSafeRef,
  CONTAINER_DATA_MOUNT,
  CONTAINER_HOME_MOUNT,
  hostAgentHomeDir,
  hostCompanyDataDir,
} from './constants';
import { isCanonicalHostPath } from './ensure-company-dirs';

export const SEAT_META_SCHEMA = 2 as const;

/** Sibling file that holds the seat's VNC password; must be mode 600. */
export const VNC_PW_FILENAME = 'vnc_pw';
export const VNC_PW_FILE_MODE = 0o600;

export interface SeatMetaV2 {
  schema: 2;
  containerName: string;
  hostPort: number;
  /** Basename of the sibling password file (mode 600) — NOT the password itself. */
  vncPasswordFile: string;
  /** OBJECT form: host path -> container path (schema 2; arrays are rejected). */
  mounts: Record<string, string>;
}

export class SeatMetaError extends Error {
  readonly code = 'invalid_seat_meta';
  constructor(message: string) {
    super(message);
    this.name = 'SeatMetaError';
  }
}

function fail(message: string): never {
  throw new SeatMetaError(message);
}

/**
 * Top-level keys a schema 2 meta.json may carry. Anything else (future fields,
 * nested secrets, `env: { VNC_PW: … }`) is a hard reject — the parser is a security
 * boundary, not a permissive reader.
 */
const SEAT_META_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'schema',
  'containerName',
  'hostPort',
  'vncPasswordFile',
  'mounts',
]);

/** Bare basename (sibling file): no separators, no leading dot, no empty. */
const BARE_BASENAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Reject `.` / `..` segments, `//`, trailing slash — host paths must arrive normalised. */
function assertNormalisedAbsolutePath(path: string, label: string): void {
  if (!path.startsWith('/') || path.endsWith('/')) {
    fail(`seat meta ${label} "${path}" must be an absolute, normalised path (no trailing slash)`);
  }
  // slice(1) drops the single leading empty segment produced by the root slash.
  for (const seg of path.slice(1).split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      fail(`seat meta ${label} "${path}" is not normalised (empty, "." or ".." segment)`);
    }
  }
}

/**
 * Enforce the canonical mount pair for exactly ONE company id + ONE agent urlKey
 * (PM+Ops lock, #282 B1):
 *
 *   { hostCompanyDataDir(companyId)       -> /data,
 *     hostAgentHomeDir(companyId, urlKey) -> /home/kasm-user }
 *
 * Rejects traversal host paths, whole-home or company-root binds, swapped targets,
 * duplicate targets, a second company's dirs, and any unsafe id/urlKey. Pure: value
 * inspection only, no filesystem access.
 */
function parseCanonicalMounts(rawMounts: unknown, containerName: string): Record<string, string> {
  if (Array.isArray(rawMounts)) {
    fail('seat meta mounts must use schema 2 OBJECT form {hostPath: containerPath}, not an array');
  }
  if (rawMounts === null || typeof rawMounts !== 'object') {
    fail('seat meta mounts must be an object mapping host path -> container path');
  }
  const entries = Object.entries(rawMounts as Record<string, unknown>);
  if (entries.length !== 2) {
    fail(`seat meta mounts must be exactly the 2 canonical binds (data + home), got ${entries.length}`);
  }

  const dataHostRe = /^\/opt\/tourbillon-company-([^/]+)\/data$/;
  const homeHostRe = /^\/opt\/tourbillon-company-([^/]+)\/home\/([^/]+)$/;

  let companyId: string | null = null;
  let urlKey: string | null = null;
  const dataHosts: string[] = [];
  const homeHosts: string[] = [];
  const targets = new Set<string>();

  for (const [host, container] of entries) {
    if (typeof container !== 'string' || container.length === 0) {
      fail(`seat meta mount "${host}" must map to a non-empty container path`);
    }
    assertNormalisedAbsolutePath(host, 'mount host path');
    if (container !== CONTAINER_DATA_MOUNT && container !== CONTAINER_HOME_MOUNT) {
      fail(`seat meta mount "${host}" -> "${container}": only ${CONTAINER_DATA_MOUNT} and ${CONTAINER_HOME_MOUNT} targets are allowed`);
    }
    if (targets.has(container)) {
      fail(`seat meta mounts bind "${container}" more than once`);
    }
    targets.add(container);

    const dataMatch = host.match(dataHostRe);
    const homeMatch = host.match(homeHostRe);
    if (container === CONTAINER_DATA_MOUNT) {
      if (!dataMatch) {
        fail(
          `seat meta mount "${host}" -> "${container}": ${CONTAINER_DATA_MOUNT} must be the company data dir ` +
            `"${hostCompanyDataDir('{companyId}')}", not a company root, home, or any other path`,
        );
      }
      dataHosts.push(host);
    } else {
      if (!homeMatch) {
        fail(
          `seat meta mount "${host}" -> "${container}": ${CONTAINER_HOME_MOUNT} must be one agent home dir ` +
            `"${hostAgentHomeDir('{companyId}', '{agentUrlKey}')}", never the whole home tree or another agent's dir`,
        );
      }
      homeHosts.push(host);
    }

    const hostCompanyId = (dataMatch ?? homeMatch)![1];
    try {
      assertSafeRef(hostCompanyId, 'seat meta mount companyId');
    } catch {
      fail(`seat meta mount host path "${host}" embeds an unsafe companyId`);
    }
    if (companyId === null) companyId = hostCompanyId;
    else if (companyId !== hostCompanyId) {
      fail(`seat meta mounts span two companies ("${companyId}" and "${hostCompanyId}"); one seat belongs to exactly one company`);
    }

    if (homeMatch) {
      try {
        assertSafeRef(homeMatch[2], 'seat meta mount agentUrlKey');
      } catch {
        fail(`seat meta mount host path "${host}" embeds an unsafe agentUrlKey`);
      }
      urlKey = homeMatch[2];
    }
  }

  if (dataHosts.length !== 1 || homeHosts.length !== 1) {
    fail('seat meta mounts must contain exactly one data bind and exactly one home bind (targets not swapped)');
  }
  if (dataHosts[0] !== hostCompanyDataDir(companyId!) || homeHosts[0] !== hostAgentHomeDir(companyId!, urlKey!)) {
    fail(
      `seat meta mounts are not the canonical pair for company "${companyId}": ` +
        `expected {${hostCompanyDataDir(companyId!)}: ${CONTAINER_DATA_MOUNT}, ${hostAgentHomeDir(companyId!, urlKey!)}: ${CONTAINER_HOME_MOUNT}}`,
    );
  }
  // Defence in depth: the exact match above already implies canonicality.
  if (!isCanonicalHostPath(dataHosts[0], companyId!) || !isCanonicalHostPath(homeHosts[0], companyId!)) {
    fail(`seat meta mount host paths are outside the canonical /opt/tourbillon-company-{companyId}/ root`);
  }
  if (!containerName.endsWith(`-${urlKey}`)) {
    fail(`seat meta containerName "${containerName}" does not end with the mounted agent urlKey "-${urlKey}"`);
  }

  return { [dataHosts[0]]: CONTAINER_DATA_MOUNT, [homeHosts[0]]: CONTAINER_HOME_MOUNT };
}

/**
 * Validate one parsed meta.json object against schema 2. Pure: inspects the value
 * only, never touches the filesystem.
 */
export function parseSeatMeta(raw: unknown): SeatMetaV2 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('seat meta must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schema === 1) fail('seat meta schema 1 is rejected (inline VNC password); schema 2 required');
  if (obj.schema !== SEAT_META_SCHEMA) fail(`seat meta schema must be ${SEAT_META_SCHEMA}, got ${String(obj.schema)}`);

  // The password itself must never be embedded (schema 1 regression guard) — checked
  // before the allowlist so the error names the secret key.
  for (const key of ['vncPassword', 'vnc_password', 'password', 'vncPw']) {
    if (key in obj) fail(`seat meta must not embed "${key}"; use vncPasswordFile -> sibling ${VNC_PW_FILENAME} (mode 600)`);
  }

  for (const key of Object.keys(obj)) {
    if (!SEAT_META_TOP_LEVEL_KEYS.has(key)) {
      fail(`seat meta has unknown top-level key "${key}"; only ${[...SEAT_META_TOP_LEVEL_KEYS].join(', ')} are allowed`);
    }
  }

  if (typeof obj.containerName !== 'string' || !/^cc-[a-z0-9][a-z0-9._-]*$/.test(obj.containerName)) {
    fail(`seat meta containerName must look like cc-<companyRef>-<urlKey>, got ${String(obj.containerName)}`);
  }

  if (!Number.isInteger(obj.hostPort) || (obj.hostPort as number) < 1024 || (obj.hostPort as number) > 65535) {
    fail(`seat meta hostPort must be an integer in 1024..65535, got ${String(obj.hostPort)}`);
  }

  if (typeof obj.vncPasswordFile !== 'string' || obj.vncPasswordFile.length === 0) {
    fail(`seat meta vncPasswordFile must name the sibling ${VNC_PW_FILENAME} file`);
  }
  const pwFile = obj.vncPasswordFile;
  if (pwFile.includes('/') || pwFile.includes('\\') || !BARE_BASENAME_RE.test(pwFile)) {
    fail(`seat meta vncPasswordFile must be a bare sibling basename (e.g. "${VNC_PW_FILENAME}"), got "${pwFile}"`);
  }

  const mounts = parseCanonicalMounts(obj.mounts, obj.containerName);

  return {
    schema: SEAT_META_SCHEMA,
    containerName: obj.containerName,
    hostPort: obj.hostPort as number,
    vncPasswordFile: pwFile,
    mounts,
  };
}
