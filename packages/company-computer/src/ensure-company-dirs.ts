/**
 * ensureCompanyDirs — PATH HELPERS ONLY (Slice 1).
 *
 * This module NEVER touches the filesystem and never talks to Docker. It computes the
 * canonical directory layout so callers (HostClient.ensureDirs, the settings-stub
 * enable flow) can plan/verify provisioning. Production directory creation belongs to
 * the Ops ensure scripts (see constants.CC_ENSURE_COMPANY_SCRIPT, under CC_BIN_DIR).
 */
import {
  assertSafeRef,
  CONTAINER_DATA_MOUNT,
  CONTAINER_HOME_MOUNT,
  hostAgentHomeDir,
  hostCompanyDataDir,
  HOST_ROOT_PREFIX,
} from './constants';
import type { ContainerMount } from './types';

export interface CompanyDirPlan {
  companyId: string;
  /** Company root on the host. */
  root: string;
  /** Shared company data dir (bind-mounted read/write at /data in every seat). */
  dataDir: string;
  /** Per-agent home dirs (each bound over /home/kasm-user in that agent's seat). */
  agentHomeDirs: string[];
}

/** Canonical host dirs for one company (and optionally each of its computer agents). */
export function ensureCompanyDirs(
  companyId: string,
  agentUrlKeys: string[] = [],
): CompanyDirPlan {
  assertSafeRef(companyId, 'companyId');
  for (const key of agentUrlKeys) assertSafeRef(key, 'agentUrlKey');
  return {
    companyId,
    root: `${HOST_ROOT_PREFIX}${companyId}`,
    dataDir: hostCompanyDataDir(companyId),
    agentHomeDirs: agentUrlKeys.map((key) => hostAgentHomeDir(companyId, key)),
  };
}

/** The two mounts every per-agent seat gets, derived from the canonical layout. */
export function mountsForAgent(companyId: string, agentUrlKey: string): ContainerMount[] {
  assertSafeRef(companyId, 'companyId');
  assertSafeRef(agentUrlKey, 'agentUrlKey');
  return [
    { source: hostCompanyDataDir(companyId), target: CONTAINER_DATA_MOUNT },
    { source: hostAgentHomeDir(companyId, agentUrlKey), target: CONTAINER_HOME_MOUNT },
  ];
}

/** True when a host path is under the canonical per-company root (guards legacy paths). */
export function isCanonicalHostPath(path: string, companyId: string): boolean {
  return path === `${HOST_ROOT_PREFIX}${companyId}` || path.startsWith(`${HOST_ROOT_PREFIX}${companyId}/`);
}
