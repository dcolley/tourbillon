'use client';

import { startTransition, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormState, useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { nativeSelectClassName } from '@/lib/native-select';
import { createGoalIssueAction, type CreateGoalIssueState } from './actions';

interface AgentOption {
  id: string;
  name: string;
  urlKey: string;
  role: string;
  title: string;
}

const initialState: CreateGoalIssueState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Creating…' : 'Create & assign'}
    </Button>
  );
}

export function NewGoalIssueDialog({
  goalId,
  agents,
}: {
  goalId: string;
  agents: AgentOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState(createGoalIssueAction, initialState);

  useEffect(() => {
    if (state?.success) {
      startTransition(() => {
        setOpen(false);
        router.refresh();
      });
    }
  }, [state?.success, router]);

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        + Add task
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <form action={formAction} className="flex min-h-0 flex-1 flex-col">
            <input type="hidden" name="goalId" value={goalId} />

            <DialogHeader className="border-b px-6 py-4">
              <DialogTitle>New task for goal</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 overflow-y-auto px-6 py-4">
              {state?.error && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {state.error}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="goal-issue-title">Title</Label>
                <Input
                  id="goal-issue-title"
                  name="title"
                  type="text"
                  required
                  autoFocus
                  placeholder="What should the agent do?"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="goal-issue-description">Description</Label>
                <Textarea
                  id="goal-issue-description"
                  name="description"
                  rows={3}
                  placeholder="Acceptance criteria, context…"
                  className="resize-y"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="goal-issue-priority">Priority</Label>
                  <select
                    id="goal-issue-priority"
                    name="priority"
                    defaultValue="medium"
                    className={nativeSelectClassName}
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="goal-issue-status">Status</Label>
                  <select
                    id="goal-issue-status"
                    name="status"
                    defaultValue="todo"
                    className={nativeSelectClassName}
                  >
                    <option value="backlog">Backlog</option>
                    <option value="todo">Todo</option>
                    <option value="in_progress">In progress</option>
                  </select>
                </div>
              </div>

              {agents.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="goal-issue-assignee">Assign to agent</Label>
                  <select
                    id="goal-issue-assignee"
                    name="assigneeAgentId"
                    defaultValue=""
                    required
                    className={nativeSelectClassName}
                  >
                    <option value="">Select agent…</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} — {agent.title} ({agent.role})
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Assigning queues a heartbeat so the agent can start work.
                  </p>
                </div>
              )}
            </div>

            <DialogFooter className="border-t bg-background">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
