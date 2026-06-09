'use server';

import { revalidatePath } from 'next/cache';
import { createGoal, updateGoal, GoalValidationError } from '@/lib/goals';
import { createIssue, IssueValidationError } from '@/lib/issues';

export type CreateGoalState = { error: string | null; success?: boolean };

export async function createGoalAction(
  _prev: CreateGoalState,
  formData: FormData
): Promise<CreateGoalState> {
  try {
    await createGoal({
      title: formData.get('title') as string,
      description: (formData.get('description') as string) || undefined,
      status: (formData.get('status') as string) || 'active',
    });
  } catch (err) {
    if (err instanceof GoalValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  revalidatePath('/goal');
  return { error: null, success: true };
}

export type UpdateGoalState = { error: string | null; success?: boolean };

export async function updateGoalAction(
  _prev: UpdateGoalState,
  formData: FormData
): Promise<UpdateGoalState> {
  const goalId = formData.get('goalId') as string;
  const ownerAgentId = formData.get('ownerAgentId') as string;

  try {
    await updateGoal(goalId, {
      title: formData.get('title') as string,
      description: (formData.get('description') as string) || null,
      status: formData.get('status') as string,
      ownerAgentId: ownerAgentId || null,
    });
  } catch (err) {
    if (err instanceof GoalValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  revalidatePath('/goal');
  revalidatePath(`/goal/${goalId}`);
  return { error: null, success: true };
}

export type CreateGoalIssueState = { error: string | null; success?: boolean };

export async function createGoalIssueAction(
  _prev: CreateGoalIssueState,
  formData: FormData
): Promise<CreateGoalIssueState> {
  const goalId = formData.get('goalId') as string;
  const assigneeAgentId = formData.get('assigneeAgentId') as string;

  try {
    await createIssue({
      title: formData.get('title') as string,
      description: (formData.get('description') as string) || undefined,
      priority: formData.get('priority') as string,
      status: (formData.get('status') as string) || 'todo',
      assigneeAgentId: assigneeAgentId || null,
      goalId,
    });
  } catch (err) {
    if (err instanceof IssueValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  revalidatePath('/goal');
  revalidatePath(`/goal/${goalId}`);
  revalidatePath('/issue');
  return { error: null, success: true };
}
