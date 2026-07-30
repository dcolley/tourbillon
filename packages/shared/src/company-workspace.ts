import { mkdir, readFile, writeFile, readdir, stat, unlink, rmdir } from 'fs/promises';
import path from 'path';
import { ROLE_DEFAULT_SKILLS, TOOLSET_SKILL_FILENAME_SET, ensureControlPlaneInSkills, CONTROL_PLANE_SKILL_SLUG } from './constants';
import { getMonorepoRoot, resolveDataPath } from './monorepo-root';
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
const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isValidSkillSlug(slug: string): boolean {
  return SKILL_SLUG_RE.test(slug);
}

function slugFromMarkdownFilename(filename: string): string | null {
  if (!filename.endsWith('.md') || filename === 'README.md') return null;
  const slug = filename.slice(0, -3);
  return isValidSkillSlug(slug) ? slug : null;
}

export function getWorkspaceRoot(): string {
  return resolveDataPath(process.env.COMPANY_WORKSPACE_ROOT, 'data/company-workspaces');
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
  await ensureCompanySkillsDir(companyId);
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

function getToolsetSkillsTemplateDir(): string {
  return path.join(getMonorepoRoot(), 'packages/mastra/src/skills');
}

export function getCompanySkillsDir(companyId: string): string {
  return path.join(getCompanyWorkspaceDir(companyId), 'skills');
}

export async function ensureCompanySkillsDir(companyId: string): Promise<string> {
  const companyDir = getCompanyWorkspaceDir(companyId);
  await mkdir(companyDir, { recursive: true });
  const dir = getCompanySkillsDir(companyId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function discoverCompanySkillSlugs(companyId: string): Promise<string[]> {
  const skillsDir = await ensureCompanySkillsDir(companyId);
  const slugs = new Set<string>();

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const entryPath = path.join(skillsDir, name);
    let entryStat: Awaited<ReturnType<typeof stat>>;
    try {
      entryStat = await stat(entryPath);
    } catch {
      continue;
    }

    if (entryStat.isFile()) {
      const slug = slugFromMarkdownFilename(name);
      if (slug) slugs.add(slug);
      continue;
    }

    if (!entryStat.isDirectory() || !isValidSkillSlug(name)) continue;
    try {
      const nestedStat = await stat(path.join(entryPath, 'SKILL.md'));
      if (nestedStat.isFile()) slugs.add(name);
    } catch {
      // no SKILL.md in directory
    }
  }

  return [...slugs].sort();
}

export async function readCompanySkillFile(companyId: string, slug: string): Promise<string | null> {
  if (!isValidSkillSlug(slug)) return null;
  const skillsDir = getCompanySkillsDir(companyId);

  const flatPath = path.join(skillsDir, `${slug}.md`);
  try {
    const content = await readFile(flatPath, 'utf-8');
    if (content.trim()) return content;
  } catch {
    // fall through
  }

  const nestedPath = path.join(skillsDir, slug, 'SKILL.md');
  try {
    const content = await readFile(nestedPath, 'utf-8');
    if (content.trim()) return content;
  } catch {
    // missing
  }

  return null;
}

export async function buildAssignedSkills(companyId: string, role: string): Promise<string[]> {
  const roleSkills = ROLE_DEFAULT_SKILLS[role] ?? [CONTROL_PLANE_SKILL_SLUG];
  const companySkillSlugs = await discoverCompanySkillSlugs(companyId);
  const seen = new Set<string>();
  const result: string[] = [];

  const push = (skillSlug: string) => {
    if (seen.has(skillSlug)) return;
    seen.add(skillSlug);
    result.push(skillSlug);
  };

  push(CONTROL_PLANE_SKILL_SLUG);
  for (const skillSlug of roleSkills) {
    if (skillSlug !== CONTROL_PLANE_SKILL_SLUG) push(skillSlug);
  }
  for (const skillSlug of companySkillSlugs) {
    push(skillSlug);
  }

  return ensureControlPlaneInSkills(result);
}

export interface AgentSkillFileRef {
  slug: string;
  filename: string;
}

export async function discoverAgentSkillFiles(
  companyId: string,
  urlKey: string,
): Promise<AgentSkillFileRef[]> {
  const dir = getAgentSkillsDir(companyId, urlKey);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const refs: AgentSkillFileRef[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith('.') || TOOLSET_SKILL_FILENAME_SET.has(name)) continue;
    const slug = slugFromMarkdownFilename(name);
    if (!slug) continue;
    const filePath = path.join(dir, name);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) refs.push({ slug, filename: name });
    } catch {
      // skip
    }
  }
  return refs;
}

export async function readAgentSkillFile(
  companyId: string,
  urlKey: string,
  filename: string,
): Promise<string | null> {
  if (!filename.endsWith('.md') || filename.includes('/') || filename.includes('..')) {
    return null;
  }
  const filePath = path.join(getAgentSkillsDir(companyId, urlKey), filename);
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

function assertValidAgentUrlKey(urlKey: string): void {
  if (!urlKey || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(urlKey)) {
    throw new WorkspacePathError('Invalid agent urlKey.');
  }
}

export function getAgentDir(companyId: string, urlKey: string): string {
  assertValidAgentUrlKey(urlKey);
  return path.join(getCompanyWorkspaceDir(companyId), 'agents', urlKey);
}

export function getAgentSkillsDir(companyId: string, urlKey: string): string {
  return path.join(getAgentDir(companyId, urlKey), 'skills');
}

/** Per-agent MCP knowledge-graph JSONL path (`MEMORY_FILE_PATH`). */
export function getAgentMemoryFilePath(companyId: string, urlKey: string): string {
  return path.join(getAgentDir(companyId, urlKey), 'memory.jsonl');
}

/** Company-shared MCP knowledge-graph JSONL at workspace root. */
export function getCompanyMemoryFilePath(companyId: string): string {
  return path.join(getCompanyWorkspaceDir(companyId), 'memory.jsonl');
}

export async function ensureCompanyMemoryDir(companyId: string): Promise<string> {
  await ensureCompanyWorkspace(companyId);
  return getCompanyWorkspaceDir(companyId);
}

export async function ensureAgentDir(companyId: string, urlKey: string): Promise<string> {
  await ensureCompanyWorkspace(companyId);
  const dir = getAgentDir(companyId, urlKey);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function ensureAgentSkillsDir(companyId: string, urlKey: string): Promise<string> {
  await ensureCompanyWorkspace(companyId);
  const dir = getAgentSkillsDir(companyId, urlKey);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function ensureAgentMemoryDir(companyId: string, urlKey: string): Promise<string> {
  return ensureAgentDir(companyId, urlKey);
}

/**
 * Copy per-agent workspace files (skills/) from one urlKey to another.
 * Does not copy memory.jsonl — clones start with an empty knowledge graph.
 * Missing source dir is a no-op. Existing dest files are not overwritten.
 */
export async function copyAgentWorkspaceSkills(
  companyId: string,
  sourceUrlKey: string,
  destUrlKey: string,
): Promise<{ copied: string[] }> {
  assertValidAgentUrlKey(sourceUrlKey);
  assertValidAgentUrlKey(destUrlKey);
  if (sourceUrlKey === destUrlKey) {
    throw new WorkspacePathError('Source and destination agent urlKeys must differ.');
  }

  await ensureCompanyWorkspace(companyId);
  const sourceDir = getAgentSkillsDir(companyId, sourceUrlKey);
  const destDir = await ensureAgentSkillsDir(companyId, destUrlKey);
  const copied: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch {
    return { copied };
  }

  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const srcPath = path.join(sourceDir, name);
    const destPath = path.join(destDir, name);
    try {
      await stat(destPath);
      continue;
    } catch {
      // missing — copy
    }
    try {
      const content = await readFile(srcPath, 'utf-8');
      await writeFile(destPath, content, 'utf-8');
      copied.push(name);
    } catch {
      // skip unreadable source files
    }
  }

  return { copied };
}

export async function seedAgentSkillsFromTemplates(
  companyId: string,
  urlKey: string,
): Promise<{ copied: string[] }> {
  const destDir = await ensureAgentSkillsDir(companyId, urlKey);
  const templateDir = getToolsetSkillsTemplateDir();
  const copied: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(templateDir);
  } catch {
    return { copied };
  }

  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const destPath = path.join(destDir, name);
    try {
      await stat(destPath);
      continue;
    } catch {
      // file does not exist — copy
    }
    const content = await readFile(path.join(templateDir, name), 'utf-8');
    await writeFile(destPath, content, 'utf-8');
    copied.push(name);
  }
  return { copied };
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
