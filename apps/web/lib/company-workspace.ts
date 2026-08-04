export type { WorkspaceEntry } from '@tourbillon/shared/company-workspace-types';
export { isTextEditablePath, isTextViewablePath, isMarkdownPath } from '@tourbillon/shared/company-workspace-types';

export {
  ensureCompanyWorkspace,
  getCompanyWorkspaceDir,
  getWorkspaceRoot,
  listWorkspaceEntries,
  readWorkspaceText,
  writeWorkspaceText,
  createWorkspaceDirectory,
  deleteWorkspaceEntry,
  renameWorkspaceEntry,
  saveWorkspaceUpload,
  WorkspacePathError,
  WorkspaceSizeError,
} from '@tourbillon/shared/company-workspace';
