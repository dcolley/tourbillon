'use client';

import { startTransition, useEffect, useState, useActionState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormStatus } from 'react-dom';
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
import { createProjectAction, type CreateProjectState } from './actions';

interface GoalOption {
  id: string;
  title: string;
}

interface AgentOption {
  id: string;
  name: string;
  urlKey: string;
  role: string;
  title: string;
}

const initialState: CreateProjectState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Creating…' : 'Create project'}
    </Button>
  );
}

export function NewProjectDialog({
  goals,
  agents,
  defaultGoalId,
  buttonLabel = '+ New project',
}: {
  goals: GoalOption[];
  agents: AgentOption[];
  defaultGoalId?: string;
  buttonLabel?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(createProjectAction, initialState);

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
        {buttonLabel}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <form action={formAction} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader className="border-b px-6 py-4">
              <DialogTitle>New project</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 overflow-y-auto px-6 py-4">
              {state?.error && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {state.error}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="project-title">Title</Label>
                <Input
                  id="project-title"
                  name="title"
                  type="text"
                  required
                  autoFocus
                  placeholder="What deliverable does this project produce?"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-description">Description</Label>
                <Textarea
                  id="project-description"
                  name="description"
                  rows={4}
                  placeholder="Scope, milestones, constraints…"
                  className="resize-y"
                />
              </div>

              {goals.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="project-goal">Goal</Label>
                  <select
                    id="project-goal"
                    name="goalId"
                    required
                    defaultValue={defaultGoalId ?? ''}
                    className={nativeSelectClassName}
                  >
                    <option value="" disabled>
                      Select goal…
                    </option>
                    {goals.map((goal) => (
                      <option key={goal.id} value={goal.id}>
                        {goal.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {agents.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="project-owner">Owner agent</Label>
                  <select
                    id="project-owner"
                    name="ownerAgentId"
                    defaultValue=""
                    className={nativeSelectClassName}
                  >
                    <option value="">Unassigned</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} — {agent.title} ({agent.role})
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Optional. The agent responsible for driving this project.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="project-status">Status</Label>
                <select
                  id="project-status"
                  name="status"
                  defaultValue="active"
                  className={nativeSelectClassName}
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="completed">Completed</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
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
