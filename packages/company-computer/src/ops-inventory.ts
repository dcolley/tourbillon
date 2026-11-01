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
import { CONTAINER_DATA_MOUNT, CONTAINER_HOME_MOUNT } from './constants';
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

  if (typeof obj.containerName !== 'string' || !/^cc-[a-z0-9][a-z0-9._-]*$/.test(obj.containerName)) {
    fail(`seat meta containerName must look like cc-<companyRef>-<urlKey>, got ${String(obj.containerName)}`);
  }

  if (!Number.isInteger(obj.hostPort) || (obj.hostPort as number) < 1024 || (obj.hostPort as number) > 65535) {
    fail(`seat meta hostPort must be an integer in 1024..65535, got ${String(obj.hostPort)}`);
  }

  // The password itself must never be embedded (schema 1 regression guard).
  for (const key of ['vncPassword', 'vnc_password', 'password', 'vncPw']) {
    if (key in obj) fail(`seat meta must not embed "${key}"; use vncPasswordFile -> sibling ${VNC_PW_FILENAME} (mode 600)`);
  }

  if (typeof obj.vncPasswordFile !== 'string' || obj.vncPasswordFile.length === 0) {
    fail(`seat meta vncPasswordFile must name the sibling ${VNC_PW_FILENAME} file`);
  }
  const pwFile = obj.vncPasswordFile;
  if (
    pwFile !== VNC_PW_FILENAME &&
    !/^[^./\\][^/\\]*$|^[^./\\][^/\\]*\/[^./\\][^/\\]*$/.test(pwFile)
  ) {
    fail(`seat meta vncPasswordFile must be a relative sibling path (e.g. "${VNC_PW_FILENAME}"), got "${pwFile}"`);
  }

  if (Array.isArray(obj.mounts)) {
    fail('seat meta mounts must use schema 2 OBJECT form {hostPath: containerPath}, not an array');
  }
  if (obj.mounts === null || typeof obj.mounts !== 'object') {
    fail('seat meta mounts must be an object mapping host path -> container path');
  }
  const mounts: Record<string, string> = {};
  const entries = Object.entries(obj.mounts as Record<string, unknown>);
  if (entries.length === 0) fail('seat meta mounts must not be empty');
  for (const [host, container] of entries) {
    if (typeof container !== 'string' || container.length === 0) {
      fail(`seat meta mount "${host}" must map to a non-empty container path`);
    }
    // Host side must stay under the canonical /opt/tourbillon-company-{companyId}/ root.
    const companyId = host.match(/^\/opt\/tourbillon-company-([^/]+)\//)?.[1];
    if (!companyId || !isCanonicalHostPath(host, companyId)) {
      fail(`seat meta mount host path "${host}" is outside the canonical /opt/tourbillon-company-{companyId}/ root`);
    }
    if (container !== CONTAINER_DATA_MOUNT && container !== CONTAINER_HOME_MOUNT) {
      fail(`seat meta mount "${host}" -> "${container}": only ${CONTAINER_DATA_MOUNT} and ${CONTAINER_HOME_MOUNT} targets are allowed`);
    }
    mounts[host] = container;
  }

  return {
    schema: SEAT_META_SCHEMA,
    containerName: obj.containerName,
    hostPort: obj.hostPort as number,
    vncPasswordFile: pwFile,
    mounts,
  };
}
