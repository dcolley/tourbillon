'use client';

import { startTransition, useActionState, useEffect, useState } from 'react';
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
import { createIssueAction, type CreateIssueState } from './actions';

interface AgentOption {
  id: string;
  name: string;
  urlKey: string;
}

interface GoalOption {
  id: string;
  title: string;
}

interface ProjectOption {
  id: string;
  title: string;
  goalId: string | null;
  status: string;
}

const initialState: CreateIssueState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Creating…' : 'Create issue'}
    </Button>
  );
}

export function NewIssueDialog({
  agents,
  goals = [],
  projects = [],
  defaultGoalId,
  buttonLabel = 'Add issue',
}: {
  agents: AgentOption[];
  goals?: GoalOption[];
  projects?: ProjectOption[];
  defaultGoalId?: string;
  buttonLabel?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selectedGoalId, setSelectedGoalId] = useState(defaultGoalId ?? '');
  const [state, formAction] = useActionState(createIssueAction, initialState);

  const filteredProjects = selectedGoalId
    ? projects.filter((p) => p.goalId === selectedGoalId)
    : projects;

  useEffect(() => {
    if (state?.success && state.issueId) {
      startTransition(() => {
        setOpen(false);
        router.push(`/issue/${state.issueId}`);
      });
    }
  }, [state?.success, state?.issueId, router]);

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {buttonLabel}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <form action={formAction} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader className="border-b px-6 py-4">
              <DialogTitle>New issue</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 overflow-y-auto px-6 py-4">
              {state?.error && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {state.error}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="issue-title">Title</Label>
                <Input
                  id="issue-title"
                  name="title"
                  type="text"
                  required
                  autoFocus
                  placeholder="What needs to be done?"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="issue-description">Description</Label>
                <Textarea
                  id="issue-description"
                  name="description"
                  rows={3}
                  placeholder="Optional details…"
                  className="resize-y"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="issue-priority">Priority</Label>
                  <select
                    id="issue-priority"
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
                  <Label htmlFor="issue-status">Status</Label>
                  <select
                    id="issue-status"
                    name="status"
                    defaultValue="todo"
                    className={nativeSelectClassName}
                  >
                    <option value="backlog">Backlog</option>
                    <option value="todo">Todo</option>
                    <option value="in_progress">In progress</option>
                    <option value="in_review">In review</option>
                    <option value="blocked">Blocked</option>
                  </select>
                </div>
              </div>

              {goals.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="issue-goal">Goal</Label>
                  <select
                    id="issue-goal"
                    name="goalId"
                    value={selectedGoalId}
                    onChange={(e) => setSelectedGoalId(e.target.value)}
                    className={nativeSelectClassName}
                  >
                    <option value="">No goal</option>
                    {goals.map((goal) => (
                      <option key={goal.id} value={goal.id}>
                        {goal.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {filteredProjects.length > 0 && (
                <div key={selectedGoalId} className="space-y-2">
                  <Label htmlFor="issue-project">Project</Label>
                  <select
                    id="issue-project"
                    name="projectId"
                    defaultValue=""
                    className={nativeSelectClassName}
                  >
                    <option value="">No project</option>
                    {filteredProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {agents.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="issue-assignee">Assign to agent</Label>
                  <select
                    id="issue-assignee"
                    name="assigneeAgentId"
                    defaultValue=""
                    className={nativeSelectClassName}
                  >
                    <option value="">Unassigned</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} ({agent.urlKey})
                      </option>
                    ))}
                  </select>
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
