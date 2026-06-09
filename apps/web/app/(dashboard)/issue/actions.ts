'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { addIssueComment } from '@/lib/issue-comments';
import { createIssue, updateIssue, IssueValidationError } from '@/lib/issues';
import { db, issues } from '@tourbillon/db';
import { eq } from 'drizzle-orm';

export type CreateIssueState = { error: string | null; success?: boolean; issueId?: string };

export async function createIssueAction(
  _prev: CreateIssueState,
  formData: FormData
): Promise<CreateIssueState> {
  const assigneeAgentId = formData.get('assigneeAgentId') as string;
  const goalId = formData.get('goalId') as string;
  const projectId = formData.get('projectId') as string;

  let created;
  try {
    created = await createIssue({
      title: formData.get('title') as string,
      description: (formData.get('description') as string) || undefined,
      priority: formData.get('priority') as string,
      status: formData.get('status') as string,
      assigneeAgentId: assigneeAgentId || null,
      goalId: goalId || null,
      projectId: projectId || null,
    });
  } catch (err) {
    if (err instanceof IssueValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  revalidatePath('/issue');
  revalidatePath('/goal');
  revalidatePath('/project');
  if (goalId) revalidatePath(`/goal/${goalId}`);
  if (projectId) revalidatePath(`/project/${projectId}`);
  revalidatePath(`/issue/${created.id}`);
  return { error: null, success: true, issueId: created.id };
}

export type UpdateIssueState = { error: string | null; success?: boolean };

export async function updateIssueAction(
  _prev: UpdateIssueState,
  formData: FormData
): Promise<UpdateIssueState> {
  const issueId = formData.get('issueId') as string;
  const assigneeAgentId = formData.get('assigneeAgentId') as string;
  const goalId = formData.get('goalId') as string;
  const projectId = formData.get('projectId') as string;

  try {
    await updateIssue(issueId, {
      title: formData.get('title') as string,
      description: (formData.get('description') as string) || null,
      priority: formData.get('priority') as string,
      status: formData.get('status') as string,
      assigneeAgentId: assigneeAgentId || null,
      goalId: goalId || null,
      projectId: projectId || null,
    });
  } catch (err) {
    if (err instanceof IssueValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  revalidatePath('/issue');
  revalidatePath(`/issue/${issueId}`);
  revalidatePath('/goal');
  revalidatePath('/project');
  if (projectId) revalidatePath(`/project/${projectId}`);
  if (goalId) revalidatePath(`/goal/${goalId}`);
  return { error: null, success: true };
}

export type CommentOnIssueState = { error: string | null; success?: boolean };

export async function commentOnIssueAction(
  _prev: CommentOnIssueState,
  formData: FormData
): Promise<CommentOnIssueState> {
  const issueId = formData.get('issueId') as string;
  const comment = (formData.get('comment') as string)?.trim();
  const status = formData.get('status') as string;
  const priority = formData.get('priority') as string;
  const assigneeAgentId = (formData.get('assigneeAgentId') as string) || null;

  if (!comment) {
    return { error: 'Comment is required.' };
  }

  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) {
    return { error: 'Issue not found.' };
  }

  try {
    await addIssueComment(issueId, issue.companyId, {
      type: 'user',
      id: 'dashboard',
      name: 'Dashboard',
    }, comment);

    const updates: Parameters<typeof updateIssue>[1] = {};
    if (status && status !== issue.status) updates.status = status;
    if (priority && priority !== issue.priority) updates.priority = priority;
    if (assigneeAgentId !== issue.assigneeAgentId) {
      updates.assigneeAgentId = assigneeAgentId;
    }

    if (Object.keys(updates).length > 0) {
      await updateIssue(issueId, updates);
    }
  } catch (err) {
    if (err instanceof IssueValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  revalidatePath('/issue');
  revalidatePath(`/issue/${issueId}`);
  redirect(`/issue/${issueId}?saved=1`);
}
