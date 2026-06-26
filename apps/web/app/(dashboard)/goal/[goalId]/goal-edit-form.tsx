'use client';

import { useEffect, useActionState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormStatus } from 'react-dom';
import type { Goal } from '@tourbillon/db';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { nativeSelectClassName } from '@/lib/native-select';
import type { UpdateGoalState } from '../actions';

export interface GoalAgentOption {
  id: string;
  name: string;
  urlKey: string;
  title: string;
  role: string;
}

const initialState: UpdateGoalState = { error: null };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : 'Save changes'}
    </Button>
  );
}

export function GoalEditForm({
  goal,
  agents,
  action,
}: {
  goal: Goal;
  agents: GoalAgentOption[];
  action: (_prev: UpdateGoalState, formData: FormData) => Promise<UpdateGoalState>;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(action, initialState);

  useEffect(() => {
    if (state?.success) {
      router.replace(`/goal/${goal.id}?saved=1`);
      router.refresh();
    }
  }, [state?.success, goal.id, router]);

  return (
    <section className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Edit goal</h2>
      </div>
      <div className="p-4 space-y-4">
        {state?.error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {state.error}
          </div>
        )}

        <form action={formAction} className="space-y-4">
          <input type="hidden" name="goalId" value={goal.id} />

          <div className="space-y-2">
            <Label htmlFor="goal-edit-title">Title</Label>
            <Input
              id="goal-edit-title"
              name="title"
              type="text"
              required
              defaultValue={goal.title}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal-edit-description">Description</Label>
            <Textarea
              id="goal-edit-description"
              name="description"
              rows={4}
              defaultValue={goal.description ?? ''}
              placeholder="Context, success criteria, constraints…"
              className="resize-y"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="goal-edit-status">Status</Label>
              <select
                id="goal-edit-status"
                name="status"
                defaultValue={goal.status}
                className={nativeSelectClassName}
              >
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="archived">Archived</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="goal-edit-owner">Assigned agent</Label>
              <select
                id="goal-edit-owner"
                name="ownerAgentId"
                defaultValue={goal.ownerAgentId ?? ''}
                className={nativeSelectClassName}
              >
                <option value="">Unassigned</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.role})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex justify-end">
            <SaveButton />
          </div>
        </form>
      </div>
    </section>
  );
}
