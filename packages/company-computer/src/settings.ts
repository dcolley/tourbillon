/**
 * Settings-stub enable/disable helpers (Slice 1).
 *
 * "Enable Company Computer" flips the DB boolean and returns the canonical host-dir
 * plan for provisioning — it does NOT create directories, pull images, or start
 * containers. Provisioning happens when the Ops ensure scripts exist (Slice 2) and a
 * seat is first created behind CC_ALLOW_START=1.
 *
 * Flag writes go through the injected ComputerFlagsStore so this stays pure/testable;
 * apps/web supplies the Drizzle-backed store (lib/company-computer-host.ts).
 */
import { assertSafeRef } from './constants';
import { ensureCompanyDirs, type CompanyDirPlan } from './ensure-company-dirs';

export interface ComputerFlagsStore {
  /** company_computers gate: companies.has_computer */
  setCompanyHasComputer(companyId: string, value: boolean): Promise<void>;
  /** agent gate: agents.has_computer */
  setAgentHasComputer(agentId: string, value: boolean): Promise<void>;
}

export interface EnableResult {
  hasComputer: true;
  /** Canonical host dirs the provisioning step will need (path plan only, not created). */
  dirs: CompanyDirPlan;
  /** True when real seats can start on this host (CC_ALLOW_START=1 + Ops scripts) — informational. */
  provisioned: false;
  note: string;
}

/**
 * Enable the Company Computer for a company (gate 1). Idempotent. Returns the
 * canonical /opt dir plan; performs no host side effects.
 */
export async function enableComputerForCompany(
  store: ComputerFlagsStore,
  companyId: string,
  agentUrlKeys: string[] = [],
): Promise<EnableResult> {
  assertSafeRef(companyId, 'companyId');
  await store.setCompanyHasComputer(companyId, true);
  return {
    hasComputer: true,
    dirs: ensureCompanyDirs(companyId, agentUrlKeys),
    provisioned: false,
    note: 'Flag set. Host directories and containers are provisioned by Ops scripts at first seat start (Slice 2, CC_ALLOW_START=1).',
  };
}

/** Disable the Company Computer for a company (gate 1 closes; seats become unreachable). */
export async function disableComputerForCompany(
  store: ComputerFlagsStore,
  companyId: string,
): Promise<{ hasComputer: false }> {
  assertSafeRef(companyId, 'companyId');
  await store.setCompanyHasComputer(companyId, false);
  return { hasComputer: false };
}

/**
 * Enable Computer access for one agent (gate 2). Board action on the agent page.
 * Returns the agent's canonical home dir plan; no host side effects.
 */
export async function enableComputerForAgent(
  store: ComputerFlagsStore,
  agentId: string,
  companyId: string,
  agentUrlKey: string,
): Promise<{ hasComputer: true; homeDir: string }> {
  assertSafeRef(agentId, 'agentId');
  assertSafeRef(companyId, 'companyId');
  assertSafeRef(agentUrlKey, 'agentUrlKey');
  await store.setAgentHasComputer(agentId, true);
  const plan = ensureCompanyDirs(companyId, [agentUrlKey]);
  return { hasComputer: true, homeDir: plan.agentHomeDirs[0] };
}

/** Disable Computer access for one agent (gate 2 closes; tool calls start failing with the locked message). */
export async function disableComputerForAgent(
  store: ComputerFlagsStore,
  agentId: string,
): Promise<{ hasComputer: false }> {
  assertSafeRef(agentId, 'agentId');
  await store.setAgentHasComputer(agentId, false);
  return { hasComputer: false };
}
