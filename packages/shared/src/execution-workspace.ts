import { access, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { WorkspacePathError } from './company-workspace-types';
import { resolveDataPath } from './monorepo-root';
import type { AgentRuntimeConfig } from './types';

const ID_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export type SandboxIsolation = 'none' | 'seatbelt' | 'bwrap';

const VALID_ISOLATION = new Set<SandboxIsolation>(['none', 'seatbelt', 'bwrap']);

const SANDBOX_README = `# Tourbillon execution sandbox

This directory is ephemeral scratch space for the current issue.
Files here are not shared across issues. Record outcomes in issue comments.

Use sandbox tools (\`mastra_workspace_execute_command\`, file tools) — not the company workspace tools.
`;

export function getExecutionWorkspaceRoot(): string {
  return resolveDataPath(process.env.EXECUTION_WORKSPACE_ROOT, 'data/execution-workspaces');
}

export function getDefaultSandboxTimeoutMs(): number {
  const raw = process.env.SANDBOX_COMMAND_TIMEOUT_MS?.trim();
  const parsed = raw ? parseInt(raw, 10) : 120_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

export function getDefaultSandboxIsolation(): SandboxIsolation {
  const raw = process.env.SANDBOX_ISOLATION?.trim().toLowerCase();
  if (raw && VALID_ISOLATION.has(raw as SandboxIsolation)) {
    return raw as SandboxIsolation;
  }
  return getRecommendedSandboxIsolation();
}

export function getRecommendedSandboxIsolation(): SandboxIsolation {
  if (process.platform === 'darwin') return 'seatbelt';
  if (process.platform === 'linux') return 'bwrap';
  return 'none';
}

export function resolveSandboxIsolation(
  runtimeConfig?: AgentRuntimeConfig | null,
): SandboxIsolation {
  const override = runtimeConfig?.codeExecution?.isolation;
  if (override && VALID_ISOLATION.has(override)) {
    return override;
  }
  return getDefaultSandboxIsolation();
}

export function resolveSandboxTimeoutMs(runtimeConfig?: AgentRuntimeConfig | null): number {
  const override = runtimeConfig?.codeExecution?.timeoutMs;
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override;
  }
  return getDefaultSandboxTimeoutMs();
}

export interface CodeExecutionAvailability {
  available: boolean;
  reason?: string;
  root: string;
  isolation: SandboxIsolation;
  timeoutMs: number;
}

function isolationSupportedOnPlatform(isolation: SandboxIsolation): boolean {
  if (isolation === 'none') return true;
  if (isolation === 'seatbelt') return process.platform === 'darwin';
  if (isolation === 'bwrap') return process.platform === 'linux';
  return false;
}

/** Check whether the in-process sandbox can run on this host. */
export async function isCodeExecutionAvailable(
  runtimeConfig?: AgentRuntimeConfig | null,
): Promise<CodeExecutionAvailability> {
  const root = getExecutionWorkspaceRoot();
  const isolation = resolveSandboxIsolation(runtimeConfig);
  const timeoutMs = resolveSandboxTimeoutMs(runtimeConfig);

  if (!isolationSupportedOnPlatform(isolation)) {
    return {
      available: false,
      reason: `Sandbox isolation "${isolation}" is not supported on ${process.platform}.`,
      root,
      isolation,
      timeoutMs,
    };
  }

  try {
    await mkdir(root, { recursive: true });
    await access(root);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: `Execution workspace root is not writable: ${message}`,
      root,
      isolation,
      timeoutMs,
    };
  }

  return { available: true, root, isolation, timeoutMs };
}

function validateCompanyId(companyId: string): void {
  if (!companyId || !ID_SEGMENT_RE.test(companyId)) {
    throw new WorkspacePathError('Invalid company id.');
  }
}

function validateScopeSegment(scope: string): void {
  if (!scope || !ID_SEGMENT_RE.test(scope)) {
    throw new WorkspacePathError('Invalid execution workspace scope.');
  }
}

export function getExecutionWorkspaceDir(companyId: string, issueId?: string): string {
  validateCompanyId(companyId);
  const scope = issueId?.trim() || 'idle';
  validateScopeSegment(scope);
  return path.join(getExecutionWorkspaceRoot(), companyId, scope);
}

/** UI-only path template — does not validate the `{issueId}` placeholder segment. */
export function formatExecutionWorkspacePathPreview(companyId: string): string {
  validateCompanyId(companyId);
  return path.join(getExecutionWorkspaceRoot(), companyId, '{issueId}');
}

export async function ensureExecutionWorkspace(companyId: string, issueId?: string): Promise<string> {
  const dir = getExecutionWorkspaceDir(companyId, issueId);
  await mkdir(dir, { recursive: true });

  const readmePath = path.join(dir, '.tourbillon', 'README.md');
  try {
    await access(readmePath);
  } catch {
    await mkdir(path.dirname(readmePath), { recursive: true });
    await writeFile(readmePath, SANDBOX_README, 'utf-8');
  }

  return dir;
}
