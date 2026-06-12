import { getOrCreateDefaultCompany } from '@/lib/company';
import {
  getCompanyWorkspaceDir,
  getWorkspaceRoot,
  listWorkspaceEntries,
  readWorkspaceText,
  isTextEditablePath,
} from '@/lib/company-workspace';
import { WorkspaceClient } from './workspace-client';

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string }>;
}) {
  const { path: selectedPath } = await searchParams;
  const company = await getOrCreateDefaultCompany();
  const entries = await listWorkspaceEntries(company.id, { recursive: true });

  let fileContent: string | null = null;
  let fileSize: number | null = null;

  if (selectedPath && isTextEditablePath(selectedPath)) {
    try {
      const file = await readWorkspaceText(company.id, selectedPath);
      fileContent = file.content;
      fileSize = file.size;
    } catch {
      fileContent = null;
    }
  } else if (selectedPath) {
    const entry = entries.find((e) => e.path === selectedPath && e.type === 'file');
    fileSize = entry?.size ?? null;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Workspace</h1>
        <p className="text-muted-foreground">
          Shared company files — accessible by all agents and editable here.
        </p>
      </div>

      <WorkspaceClient
        entries={entries}
        workspaceRoot={getWorkspaceRoot()}
        companyWorkspaceDir={getCompanyWorkspaceDir(company.id)}
        selectedPath={selectedPath ?? null}
        fileContent={fileContent}
        fileSize={fileSize}
      />
    </div>
  );
}
