'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assigneesFromFormSelect } from '@tourbillon/shared';
import { addIssueComment } from '@/lib/issue-comments';
import { createIssue, updateIssue, IssueValidationError } from '@/lib/issues';
import { releaseIssueCheckoutLock } from '@/lib/checkout-lock';
import { db, issues, type Issue } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { requireBoardSession } from '@/lib/company';

export type CreateIssueState = {
  error: string | null;
  success?: boolean;
  issueId?: string;
  issueIdentifier?: string;
};

function revalidateIssuePaths(issue: { id: string; identifier: string }): void {
  revalidatePath(`/issue/${issue.id}`);
  revalidatePath(`/issue/${issue.identifier}`);
}

export async function createIssueAction(
  _prev: CreateIssueState,
  formData: FormData
): Promise<CreateIssueState> {
  await requireBoardSession();
  const assignees = assigneesFromFormSelect(formData.get('assigneeAgentId') as string);
  const goalId = formData.get('goalId') as string;
  const projectId = formData.get('projectId') as string;

  let created;
  try {
    created = await createIssue({
      title: formData.get('title') as string,
      description: (formData.get('description') as string) || undefined,
      priority: formData.get('priority') as string,
      status: formData.get('status') as string,
      assigneeAgentId: assignees.assigneeAgentId,
      assigneeUserId: assignees.assigneeUserId,
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
  revalidatePath(`/issue/${created.identifier}`);
  return { error: null, success: true, issueId: created.id, issueIdentifier: created.identifier };
}

export type UpdateIssueDescriptionState = { error: string | null; success?: boolean };

export async function updateIssueDescriptionAction(
  _prev: UpdateIssueDescriptionState,
  formData: FormData
): Promise<UpdateIssueDescriptionState> {
  await requireBoardSession();
  const issueId = formData.get('issueId') as string;

  let updated: Issue;
  try {
    updated = await updateIssue(issueId, {
      description: (formData.get('description') as string) || null,
    });
  } catch (err) {
    if (err instanceof IssueValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  revalidatePath('/issue');
  revalidateIssuePaths(updated);
  return { error: null, success: true };
}

export type UpdateIssueState = { error: string | null; success?: boolean };

export async function updateIssueAction(
  _prev: UpdateIssueState,
  formData: FormData
): Promise<UpdateIssueState> {
  await requireBoardSession();
  const issueId = formData.get('issueId') as string;
  const assignees = assigneesFromFormSelect(formData.get('assigneeAgentId') as string);
  const goalId = formData.get('goalId') as string;
  const projectId = formData.get('projectId') as string;

  let updated: Issue;
  try {
    updated = await updateIssue(issueId, {
      title: formData.get('title') as string,
      priority: formData.get('priority') as string,
      status: formData.get('status') as string,
      assigneeAgentId: assignees.assigneeAgentId,
      assigneeUserId: assignees.assigneeUserId,
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
  revalidateIssuePaths(updated);
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
  await requireBoardSession();
  const issueId = formData.get('issueId') as string;
  const comment = (formData.get('comment') as string)?.trim();
  const status = formData.get('status') as string;
  const priority = formData.get('priority') as string;
  const assignees = assigneesFromFormSelect(formData.get('assigneeAgentId') as string);

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
    if (
      assignees.assigneeAgentId !== issue.assigneeAgentId ||
      assignees.assigneeUserId !== issue.assigneeUserId
    ) {
      updates.assigneeAgentId = assignees.assigneeAgentId;
      updates.assigneeUserId = assignees.assigneeUserId;
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
  revalidateIssuePaths(issue);
  redirect(`/issue/${issue.identifier}?saved=1`);
}

export async function releaseCheckoutLockAction(formData: FormData): Promise<void> {
  await requireBoardSession();
  const issueId = formData.get('issueId') as string;
  if (!issueId) return;

  const released = await releaseIssueCheckoutLock(issueId, {
    type: 'user',
    id: 'dashboard',
    name: 'Dashboard',
  });

  revalidatePath('/issue');
  revalidateIssuePaths(released);
  redirect(`/issue/${released.identifier}?saved=1`);
}
