export type { WorkspaceEntry } from '@tourbillon/shared/company-workspace-types';
export { isTextEditablePath, isTextViewablePath, isMarkdownPath } from '@tourbillon/shared/company-workspace-types';

export {
  ensureCompanyWorkspace,
  getCompanyWorkspaceDir,
  getWorkspaceRoot,
  listWorkspaceEntries,
  readWorkspaceText,
  writeWorkspaceText,
  deleteWorkspaceEntry,
  saveWorkspaceUpload,
  WorkspacePathError,
  WorkspaceSizeError,
} from '@tourbillon/shared/company-workspace';
