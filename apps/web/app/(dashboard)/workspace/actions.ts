'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getActiveCompany } from '@/lib/company';
import {
  writeWorkspaceText,
  deleteWorkspaceEntry,
  saveWorkspaceUpload,
  WorkspacePathError,
  WorkspaceSizeError,
} from '@/lib/company-workspace';

export type WorkspaceActionState = { error: string | null; success?: boolean };

export async function saveWorkspaceFileAction(
  _prev: WorkspaceActionState,
  formData: FormData
): Promise<WorkspaceActionState> {
  const company = await getActiveCompany();
  const path = (formData.get('path') as string)?.trim();
  const content = formData.get('content') as string;

  if (!path) return { error: 'File path is required.' };
  if (typeof content !== 'string') return { error: 'Content is required.' };

  try {
    await writeWorkspaceText(company.id, path, content);
    revalidatePath('/workspace');
    return { error: null, success: true };
  } catch (err) {
    if (err instanceof WorkspacePathError || err instanceof WorkspaceSizeError) {
      return { error: err.message };
    }
    throw err;
  }
}

export async function deleteWorkspaceFileAction(
  _prev: WorkspaceActionState,
  formData: FormData
): Promise<WorkspaceActionState> {
  const company = await getActiveCompany();
  const path = (formData.get('path') as string)?.trim();
  if (!path) return { error: 'Path is required.' };

  try {
    await deleteWorkspaceEntry(company.id, path);
    revalidatePath('/workspace');
    redirect('/workspace');
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      return { error: err.message };
    }
    throw err;
  }
}

export async function uploadWorkspaceFileAction(
  _prev: WorkspaceActionState,
  formData: FormData
): Promise<WorkspaceActionState> {
  const company = await getActiveCompany();
  const targetDir = ((formData.get('targetDir') as string) ?? '').trim();
  const file = formData.get('file');

  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose a file to upload.' };
  }

  const baseName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const relativePath = targetDir ? `${targetDir}/${baseName}` : baseName;

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await saveWorkspaceUpload(company.id, relativePath, buffer);
    revalidatePath('/workspace');
    return { error: null, success: true };
  } catch (err) {
    if (err instanceof WorkspacePathError || err instanceof WorkspaceSizeError) {
      return { error: err.message };
    }
    throw err;
  }
}
