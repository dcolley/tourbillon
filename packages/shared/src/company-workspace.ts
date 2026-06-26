import { mkdir, readFile, writeFile, readdir, stat, unlink, rmdir } from 'fs/promises';
import path from 'path';
import {
  WORKSPACE_MAX_TEXT_BYTES,
  WORKSPACE_MAX_UPLOAD_BYTES,
  WORKSPACE_PARA_DIRS,
  WORKSPACE_README,
  WorkspacePathError,
  WorkspaceSizeError,
  type WorkspaceEntry,
} from './company-workspace-types';

export {
  WORKSPACE_MAX_TEXT_BYTES,
  WORKSPACE_MAX_UPLOAD_BYTES,
  WORKSPACE_PARA_DIRS,
  WORKSPACE_README,
  WorkspacePathError,
  WorkspaceSizeError,
  isTextEditablePath,
  isTextViewablePath,
  type WorkspaceEntry,
  type WorkspaceEntryType,
} from './company-workspace-types';

const RELATIVE_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

function defaultWorkspaceRoot(): string {
  return path.resolve(process.cwd(), 'data', 'company-workspaces');
}

export function getWorkspaceRoot(): string {
  const raw = process.env.COMPANY_WORKSPACE_ROOT?.trim();
  const resolved = raw ? path.resolve(raw) : defaultWorkspaceRoot();
  return resolved;
}

export function getCompanyWorkspaceDir(companyId: string): string {
  if (!companyId || !/^[a-zA-Z0-9_-]+$/.test(companyId)) {
    throw new WorkspacePathError('Invalid company id.');
  }
  return path.join(getWorkspaceRoot(), companyId);
}

export function normalizeRelativePath(relativePath: string): string {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '.') return '';
  if (trimmed.startsWith('/') || trimmed.includes('..')) {
    throw new WorkspacePathError('Path must be relative to the company workspace root.');
  }
  const segments = trimmed.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new WorkspacePathError('Path must not contain . or .. segments.');
    }
    if (!RELATIVE_PATH_RE.test(segment) && segment !== '') {
      throw new WorkspacePathError(
        'Path segments may only contain letters, numbers, dots, underscores, and hyphens.'
      );
    }
  }
  return segments.join('/');
}

export async function resolveSafePath(companyId: string, relativePath: string): Promise<string> {
  const companyDir = getCompanyWorkspaceDir(companyId);
  const normalized = normalizeRelativePath(relativePath);
  const absolute = normalized ? path.join(companyDir, normalized) : companyDir;
  const resolved = path.resolve(absolute);
  const rootResolved = path.resolve(companyDir);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new WorkspacePathError('Path escapes company workspace.');
  }
  return resolved;
}

export async function ensureCompanyWorkspace(companyId: string): Promise<string> {
  const companyDir = getCompanyWorkspaceDir(companyId);
  await mkdir(companyDir, { recursive: true });
  for (const dir of WORKSPACE_PARA_DIRS) {
    await mkdir(path.join(companyDir, dir), { recursive: true });
  }
  const readmePath = path.join(companyDir, 'README.md');
  try {
    await stat(readmePath);
  } catch {
    await writeFile(readmePath, WORKSPACE_README, 'utf-8');
  }
  return companyDir;
}

async function entryFromStat(
  relativePath: string,
  name: string,
  entryStat: Awaited<ReturnType<typeof stat>>
): Promise<WorkspaceEntry> {
  return {
    name,
    path: relativePath,
    type: entryStat.isDirectory() ? 'directory' : 'file',
    size: entryStat.isFile() ? Number(entryStat.size) : null,
    updatedAt: entryStat.mtime.toISOString(),
  };
}

export async function listWorkspaceEntries(
  companyId: string,
  options?: { relativeDir?: string; recursive?: boolean }
): Promise<WorkspaceEntry[]> {
  await ensureCompanyWorkspace(companyId);
  const relativeDir = normalizeRelativePath(options?.relativeDir ?? '');
  const dirPath = await resolveSafePath(companyId, relativeDir);
  const dirStat = await stat(dirPath);
  if (!dirStat.isDirectory()) {
    throw new WorkspacePathError('Not a directory.');
  }

  const entries: WorkspaceEntry[] = [];
  const names = await readdir(dirPath);
  for (const name of names.sort()) {
    const childRelative = relativeDir ? `${relativeDir}/${name}` : name;
    const childPath = path.join(dirPath, name);
    const childStat = await stat(childPath);
    entries.push(await entryFromStat(childRelative, name, childStat));

    if (options?.recursive && childStat.isDirectory()) {
      const nested = await listWorkspaceEntries(companyId, {
        relativeDir: childRelative,
        recursive: true,
      });
      entries.push(...nested);
    }
  }
  return entries;
}

export async function readWorkspaceText(
  companyId: string,
  relativePath: string
): Promise<{ content: string; path: string; size: number }> {
  await ensureCompanyWorkspace(companyId);
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) throw new WorkspacePathError('File path is required.');
  const filePath = await resolveSafePath(companyId, normalized);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new WorkspacePathError('Not a file.');
  if (fileStat.size > WORKSPACE_MAX_TEXT_BYTES) {
    throw new WorkspaceSizeError(`File exceeds ${WORKSPACE_MAX_TEXT_BYTES} byte text limit.`);
  }
  const content = await readFile(filePath, 'utf-8');
  return { content, path: normalized, size: Number(fileStat.size) };
}

export async function writeWorkspaceText(
  companyId: string,
  relativePath: string,
  content: string
): Promise<{ path: string; size: number }> {
  await ensureCompanyWorkspace(companyId);
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) throw new WorkspacePathError('File path is required.');
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > WORKSPACE_MAX_TEXT_BYTES) {
    throw new WorkspaceSizeError(`Content exceeds ${WORKSPACE_MAX_TEXT_BYTES} byte limit.`);
  }
  const filePath = await resolveSafePath(companyId, normalized);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
  return { path: normalized, size: bytes };
}

export async function saveWorkspaceUpload(
  companyId: string,
  relativePath: string,
  data: Buffer
): Promise<{ path: string; size: number }> {
  await ensureCompanyWorkspace(companyId);
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) throw new WorkspacePathError('File path is required.');
  if (data.length > WORKSPACE_MAX_UPLOAD_BYTES) {
    throw new WorkspaceSizeError(`Upload exceeds ${WORKSPACE_MAX_UPLOAD_BYTES} byte limit.`);
  }
  const filePath = await resolveSafePath(companyId, normalized);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, data);
  return { path: normalized, size: data.length };
}

export async function deleteWorkspaceEntry(
  companyId: string,
  relativePath: string
): Promise<{ path: string }> {
  await ensureCompanyWorkspace(companyId);
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) throw new WorkspacePathError('Path is required.');
  const entryPath = await resolveSafePath(companyId, normalized);
  const entryStat = await stat(entryPath);
  if (entryStat.isDirectory()) {
    const children = await readdir(entryPath);
    if (children.length > 0) {
      throw new WorkspacePathError('Directory is not empty.');
    }
    await rmdir(entryPath);
  } else {
    await unlink(entryPath);
  }
  return { path: normalized };
}
