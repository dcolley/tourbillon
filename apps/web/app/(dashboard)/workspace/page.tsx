import { getActiveCompany } from '@/lib/company';
import {
  getCompanyWorkspaceDir,
  getWorkspaceRoot,
  listWorkspaceEntries,
  readWorkspaceText,
  isTextViewablePath,
} from '@/lib/company-workspace';
import { WorkspaceClient } from './workspace-client';

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string }>;
}) {
  const { path: selectedPath } = await searchParams;
  const company = await getActiveCompany();
  const entries = await listWorkspaceEntries(company.id, { recursive: false });

  let initialContent: string | null = null;

  if (selectedPath && isTextViewablePath(selectedPath)) {
    try {
      const file = await readWorkspaceText(company.id, selectedPath);
      initialContent = file.content;
    } catch {
      initialContent = null;
    }
  }

  return (
    <div className="max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Workspace</h1>
        <p className="text-muted-foreground">
          Shared company files — accessible by all agents and editable here.
        </p>
      </div>

      <WorkspaceClient
        initialEntries={entries}
        selectedPath={selectedPath ?? null}
        initialContent={initialContent}
        workspaceRoot={getWorkspaceRoot()}
        companyWorkspaceDir={getCompanyWorkspaceDir(company.id)}
      />
    </div>
  );
}
