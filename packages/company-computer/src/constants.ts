/**
 * Company Computer — canonical constants (Slice 1).
 *
 * These values are a PM + Ops lock (2026-10-31). The ONLY sanctioned host layout is
 * `/opt/tourbillon-company-{companyId}/…` — the earlier Ops draft under
 * `/home/derek/company-computers/<slug>/shared/{home,data}` (mounting a shared overlay
 * over `/home/kasm-user/shared`) is DISCARDED; do not reintroduce it.
 *
 * One `kasmweb/desktop` container per AGENT (not multi-seat). Slice 1 is app code only:
 * nothing here pulls an image or starts a container — the production HostClient shells to
 * Ops ensure scripts only when `CC_ALLOW_START=1` AND the scripts exist (Ops contract).
 */

/** Pin the image explicitly; bump deliberately with Ops. */
export const KASM_IMAGE = 'kasmweb/desktop:1.19.0';

/** KasmVNC listens on 6901 inside the container. */
export const CONTAINER_VNC_PORT = 6901;

/** First host port handed out; per-agent containers take 6901, 6902, … */
export const PORT_BASE = 6901;

/**
 * Host-wide cap on non-destroyed seats (Ops brief: ~4 TEST seats max). Slice 1 enforces
 * it from the registry; the count is host-wide because all seats share this one host.
 */
export const MAX_ACTIVE_SEATS = 4;

/** Host root prefix. Full host root for a company: `${HOST_ROOT_PREFIX}${companyId}`. */
export const HOST_ROOT_PREFIX = '/opt/tourbillon-company-';

/** Host dir shared by every agent of one company (read/write collaboration). */
export function hostCompanyDataDir(companyId: string): string {
  return `${HOST_ROOT_PREFIX}${companyId}/data`;
}

/** Host dir that is THIS agent's home (per-agent container binds it over /home/kasm-user). */
export function hostAgentHomeDir(companyId: string, agentUrlKey: string): string {
  return `${HOST_ROOT_PREFIX}${companyId}/home/${agentUrlKey}`;
}

/** Container mount points (fixed; the Kasm image expects these). */
export const CONTAINER_DATA_MOUNT = '/data';
export const CONTAINER_HOME_MOUNT = '/home/kasm-user';

/** Container name: `cc-<companySlug-or-id>-<agentUrlKey>`. */
export function containerName(companyRef: string, agentUrlKey: string): string {
  return `cc-${companyRef}-${agentUrlKey}`;
}

/** Env gate for the production HostClient to be allowed to start containers at all. */
export const CC_ALLOW_START_ENV = 'CC_ALLOW_START';

/** Env gate for Ops scripts to create/modify the canonical /opt trees (needs sudo on the host). */
export const CC_APPLY_ENV = 'CC_APPLY';

/** Env override for the Ops bin dir. Ops scripts live together there with cc-lib.sh. */
export const CC_BIN_DIR_ENV = 'CC_BIN_DIR';

/** Default Ops bin dir (Ops contract). Never invent another bin location such as
 * `/opt/tourbillon-company-computer/bin/ensure-*` — the sanctioned scripts are the cc-*
 * set below, shelled to from this directory only. */
export const DEFAULT_CC_BIN_DIR = '/home/derek/company-computers/bin';

/** Ops-provided scripts the production HostClient will call (Slice 2; absent = refuse). */
export const CC_ENSURE_COMPANY_SCRIPT = 'cc-ensure-company';
export const CC_ENSURE_SEAT_SCRIPT = 'cc-ensure-seat';
export const CC_TEARDOWN_SEAT_SCRIPT = 'cc-teardown-seat';
export const CC_TEARDOWN_COMPANY_SCRIPT = 'cc-teardown-company';
export const CC_LIB_SCRIPT = 'cc-lib.sh';

/** Resolve one Ops script to its absolute path under CC_BIN_DIR (env-injectable). */
export function ccBinPath(
  script: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const dir = env[CC_BIN_DIR_ENV]?.trim() || DEFAULT_CC_BIN_DIR;
  return `${dir.replace(/\/+$/, '')}/${script}`;
}

/** Session statuses stored in company_computer_sessions.status. */
export const SESSION_STATUSES = ['starting', 'running', 'stopped', 'destroyed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Actions the Slice-1 API surface dispatches on. Implemented vs. stubbed. */
export const IMPLEMENTED_ACTIONS = [
  'createSession',
  'getSession',
  'destroySession',
  'openBrowser',
  'screenshot',
  'click',
  'typeText',
  'getSessionInfo',
] as const;

export const STUBBED_ACTIONS = [
  'openFileManager',
  'openTerminal',
  'pressKey',
  'mouseMove',
  'scroll',
] as const;

export type ComputerAction = (typeof IMPLEMENTED_ACTIONS)[number] | (typeof STUBBED_ACTIONS)[number];

export function isComputerAction(action: string): action is ComputerAction {
  return (
    (IMPLEMENTED_ACTIONS as readonly string[]).includes(action) ||
    (STUBBED_ACTIONS as readonly string[]).includes(action)
  );
}

/** Gate error strings (locked wording — agents quote them back to the Board). */
export const GATE_COMPANY_NOT_PROVISIONED =
  'Company Computer not provisioned. Ask Board to enable at /settings/company-computer.';
export const GATE_AGENT_NO_COMPUTER =
  'Agent does not have Computer access. Ask Board to enable hasComputer on the agent detail page.';

/** docker-safe: lowercase letters, digits, dot, dash, underscore (no leading separator). */
const SAFE_REF_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Throw when a value would produce an unsafe path segment or container name part. */
export function assertSafeRef(value: string, label: string): string {
  if (!SAFE_REF_RE.test(value)) {
    throw new InvalidRefError(`${label} "${value}" is not a safe reference (expected [a-z0-9][a-z0-9._-]*)`);
  }
  return value;
}

/** companySlug when present, else companyId (container naming rule from the queue brief). */
export function companyRefFor(containerSlug: string | null | undefined, companyId: string): string {
  const slug = containerSlug?.trim();
  return slug && SAFE_REF_RE.test(slug) ? slug : companyId;
}

export class InvalidRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRefError';
  }
}
