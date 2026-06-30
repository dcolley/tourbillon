export const WORKSPACE_MAX_TEXT_BYTES = 1_048_576; // 1 MB
export const WORKSPACE_MAX_UPLOAD_BYTES = 10_485_760; // 10 MB

export const WORKSPACE_PARA_DIRS = ['projects', 'areas', 'resources', 'archives'] as const;

export const WORKSPACE_README = `# Company workspace

Shared files for all agents in this company. Use control-plane workspace tools.

- \`resources/\` — reference docs (brand, architecture, standards)
- \`projects/\` — active initiative material
- \`areas/\` — ongoing playbooks and responsibilities
- \`archives/\` — completed material
- \`agents/{urlKey}/skills/\` — per-agent toolset skill copies (seeded at hire time; editable)

Task thread of record: issue comments. Task plans: \`putPlanDocument\`.
`;

export type WorkspaceEntryType = 'file' | 'directory';

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: WorkspaceEntryType;
  size: number | null;
  updatedAt: string;
}

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export class WorkspaceSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSizeError';
  }
}

const TEXT_EDITABLE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv']);

const CODE_VIEWABLE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.vue',
  '.svelte',
]);

function fileExtension(relativePath: string): string | null {
  const dot = relativePath.lastIndexOf('.');
  if (dot === -1) return null;
  return relativePath.slice(dot).toLowerCase();
}

export function isTextEditablePath(relativePath: string): boolean {
  const ext = fileExtension(relativePath);
  if (!ext) return false;
  return TEXT_EDITABLE_EXTENSIONS.has(ext);
}

export function isTextViewablePath(relativePath: string): boolean {
  const ext = fileExtension(relativePath);
  if (!ext) return false;
  return TEXT_EDITABLE_EXTENSIONS.has(ext) || CODE_VIEWABLE_EXTENSIONS.has(ext);
}

export function isMarkdownPath(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith('.md');
}
