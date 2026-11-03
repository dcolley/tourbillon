/**
 * Dry-run HostClient — the ONLY HostClient Slice 1 ships.
 *
 * Slice 1 is app code only: it must never pull an image or start a container. The
 * production implementation (Slice 2, Ops contract) will shell to the Ops ensure
 * scripts and is gated on CC_ALLOW_START=1. Until BOTH the flag and the scripts are
 * in place, startContainer refuses — that refusal is the expected behaviour on
 * Spark1 (zero seats in inventory until Derek enables).
 */
import {
  CC_ALLOW_START_ENV,
  CC_APPLY_ENV,
  CC_ENSURE_COMPANY_SCRIPT,
  CC_ENSURE_SEAT_SCRIPT,
  CC_TEARDOWN_SEAT_SCRIPT,
  ccBinPath,
} from './constants';
import { HostBackendUnavailableError, HostStartRefusedError, type ContainerSpec, type HostClient } from './types';

export interface DryRunHostClientOptions {
  /** Defaults to process.env; injectable for tests. */
  env?: Record<string, string | undefined>;
  /** Override the Ops-script existence probe (tests). Default: never exists. */
  opsScriptExists?: (script: string) => boolean;
}

function defaultEnv(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

export function createDryRunHostClient(options: DryRunHostClientOptions = {}): HostClient {
  const env = options.env ?? defaultEnv();
  const opsScriptExists = options.opsScriptExists ?? (() => false);
  const allowStart = env[CC_ALLOW_START_ENV] === '1';
  const apply = env[CC_APPLY_ENV] === '1';

  return {
    async ensureDirs(_dirs: string[]): Promise<void> {
      // Dry run: nothing is created. Production: Ops cc-ensure-company over the /opt trees
      // (CC_APPLY=1 — the trees need sudo on the host).
      if (apply && opsScriptExists(ccBinPath(CC_ENSURE_COMPANY_SCRIPT, env))) {
        // Slice 2 will shell out here. Slice 1 must not, even when enabled.
        throw new HostBackendUnavailableError(
          `Ops script ${CC_ENSURE_COMPANY_SCRIPT} found but the production HostClient is not wired yet (Slice 2).`,
        );
      }
      return;
    },

    async startContainer(spec: ContainerSpec): Promise<{ containerId: string; startedAt: Date }> {
      if (!allowStart) {
        throw new HostStartRefusedError(
          `Container start refused: set ${CC_ALLOW_START_ENV}=1 (Ops contract) to enable real seats. ` +
            `Planned container "${spec.name}" (${spec.image}, host port ${spec.hostPort}) was NOT started.`,
        );
      }
      if (!opsScriptExists(ccBinPath(CC_ENSURE_SEAT_SCRIPT, env))) {
        throw new HostBackendUnavailableError(
          `${CC_ALLOW_START_ENV}=1 but Ops seat script ${CC_ENSURE_SEAT_SCRIPT} (under CC_BIN_DIR, ` +
            `default /home/derek/company-computers/bin) does not exist yet — refusing to start "${spec.name}".`,
        );
      }
      throw new HostBackendUnavailableError(
        `Ops script ${CC_ENSURE_SEAT_SCRIPT} found but the production HostClient is not wired yet (Slice 2).`,
      );
    },

    async stopAndRemove(_containerName: string): Promise<void> {
      if (allowStart && opsScriptExists(ccBinPath(CC_TEARDOWN_SEAT_SCRIPT, env))) {
        throw new HostBackendUnavailableError(
          `Ops teardown script ${CC_TEARDOWN_SEAT_SCRIPT} found but the production HostClient is not wired yet (Slice 2).`,
        );
      }
      // Dry run: nothing was ever started, so nothing to remove.
      return;
    },

    async healthCheck(): Promise<boolean> {
      // Dry run: no container can exist, so it is never healthy.
      return false;
    },

    async execInContainer(containerName: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      throw new HostBackendUnavailableError(
        `exec refused in dry-run HostClient: no container "${containerName}" is running (Slice 2 Ops contract).`,
      );
    },

    async screenshot(containerName: string): Promise<{ imageBase64: string; width: number; height: number }> {
      throw new HostBackendUnavailableError(
        `screenshot refused in dry-run HostClient: no container "${containerName}" is running (Slice 2 Ops contract).`,
      );
    },

    async sendInput(containerName: string): Promise<{ success: boolean }> {
      throw new HostBackendUnavailableError(
        `input refused in dry-run HostClient: no container "${containerName}" is running (Slice 2 Ops contract).`,
      );
    },
  };
}
