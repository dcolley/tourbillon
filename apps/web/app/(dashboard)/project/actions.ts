'use server';

import { revalidatePath } from 'next/cache';
import { createProject, ProjectValidationError } from '@/lib/projects';
import { createIssue, IssueValidationError } from '@/lib/issues';

export type CreateProjectState = { error: string | null; success?: boolean };

export async function createProjectAction(
  _prev: CreateProjectState,
  formData: FormData
): Promise<CreateProjectState> {
  const goalId = formData.get('goalId') as string;
  const ownerAgentId = formData.get('ownerAgentId') as string;

  try {
    await createProject({
      title: formData.get('title') as string,
      description: (formData.get('description') as string) || undefined,
      status: (formData.get('status') as string) || 'active',
      goalId,
      ownerAgentId: ownerAgentId || null,
    });
  } catch (err) {
    if (err instanceof ProjectValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  revalidatePath('/project');
  revalidatePath('/goal');
  if (goalId) revalidatePath(`/goal/${goalId}`);
  return { error: null, success: true };
}

export type CreateProjectIssueState = { error: string | null; success?: boolean };

export async function createProjectIssueAction(
  _prev: CreateProjectIssueState,
  formData: FormData
): Promise<CreateProjectIssueState> {
  const projectId = formData.get('projectId') as string;
  const assigneeAgentId = formData.get('assigneeAgentId') as string;

  try {
    await createIssue({
      title: formData.get('title') as string,
      description: (formData.get('description') as string) || undefined,
      priority: formData.get('priority') as string,
      status: (formData.get('status') as string) || 'todo',
      assigneeAgentId: assigneeAgentId || null,
      projectId,
    });
  } catch (err) {
    if (err instanceof IssueValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  revalidatePath('/project');
  revalidatePath(`/project/${projectId}`);
  revalidatePath('/goal');
  revalidatePath('/issue');
  return { error: null, success: true };
}
