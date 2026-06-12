import { mkdir } from 'fs/promises';
import path from 'path';
import { WorkspacePathError } from './company-workspace-types';

const ID_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

function defaultExecutionWorkspaceRoot(): string {
  return path.resolve(process.cwd(), 'data', 'execution-workspaces');
}

export function getExecutionWorkspaceRoot(): string {
  const raw = process.env.EXECUTION_WORKSPACE_ROOT?.trim();
  return raw ? path.resolve(raw) : defaultExecutionWorkspaceRoot();
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

export async function ensureExecutionWorkspace(companyId: string, issueId?: string): Promise<string> {
  const dir = getExecutionWorkspaceDir(companyId, issueId);
  await mkdir(dir, { recursive: true });
  return dir;
}
