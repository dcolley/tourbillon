'use client';

import { startTransition, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormState, useFormStatus } from 'react-dom';
import type { Issue } from '@tourbillon/db';
import type { GoalOption } from '@/lib/goals';
import type { ProjectOption } from '@/lib/projects';
import type { IssueAgentOption } from '@/lib/issues';
import type { UpdateIssueState } from '../actions';

const initialState: UpdateIssueState = { error: null };

const inputClassName =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const selectClassName = inputClassName;

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save changes'}
    </button>
  );
}

export function IssueEditForm({
  issue,
  agents,
  goals = [],
  projects = [],
  action,
}: {
  issue: Issue;
  agents: IssueAgentOption[];
  goals?: GoalOption[];
  projects?: ProjectOption[];
  action: (_prev: UpdateIssueState, formData: FormData) => Promise<UpdateIssueState>;
}) {
  const router = useRouter();
  const [state, formAction] = useFormState(action, initialState);
  const [selectedGoalId, setSelectedGoalId] = useState(issue.goalId ?? '');
  const [selectedProjectId, setSelectedProjectId] = useState(issue.projectId ?? '');

  const filteredProjects = selectedGoalId
    ? projects.filter((p) => p.goalId === selectedGoalId)
    : projects;
  const projectSelectValue = filteredProjects.some((p) => p.id === selectedProjectId)
    ? selectedProjectId
    : '';

  useEffect(() => {
    if (state?.success) {
      startTransition(() => {
        router.replace(`/issue/${issue.id}?saved=1`);
        router.refresh();
      });
    }
  }, [state?.success, issue.id, router]);

  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h2 className="text-lg font-semibold">Edit issue</h2>
      </div>

      <form action={formAction} className="space-y-4 p-4">
        {state?.error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {state.error}
          </div>
        )}

        <input type="hidden" name="issueId" value={issue.id} />

        <div className="space-y-1.5">
          <label htmlFor="issue-title" className="text-sm font-medium">
            Title
          </label>
          <input
            id="issue-title"
            name="title"
            type="text"
            required
            defaultValue={issue.title}
            className={inputClassName}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="issue-description" className="text-sm font-medium">
            Description
          </label>
          <textarea
            id="issue-description"
            name="description"
            rows={4}
            defaultValue={issue.description ?? ''}
            placeholder="Optional details…"
            className={`${inputClassName} resize-y`}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="issue-priority" className="text-sm font-medium">
              Priority
            </label>
            <select
              id="issue-priority"
              name="priority"
              defaultValue={issue.priority}
              className={selectClassName}
            >
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="issue-status" className="text-sm font-medium">
              Status
            </label>
            <select
              id="issue-status"
              name="status"
              defaultValue={issue.status}
              className={selectClassName}
            >
              <option value="backlog">Backlog</option>
              <option value="todo">Todo</option>
              <option value="in_progress">In progress</option>
              <option value="in_review">In review</option>
              <option value="done">Done</option>
              <option value="blocked">Blocked</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>

        {goals.length > 0 && (
          <div className="space-y-1.5">
            <label htmlFor="issue-goal" className="text-sm font-medium">
              Goal
            </label>
            <select
              id="issue-goal"
              name="goalId"
              value={selectedGoalId}
              onChange={(e) => {
                setSelectedGoalId(e.target.value);
                setSelectedProjectId('');
              }}
              className={selectClassName}
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
          <div className="space-y-1.5">
            <label htmlFor="issue-project" className="text-sm font-medium">
              Project
            </label>
            <select
              id="issue-project"
              name="projectId"
              value={projectSelectValue}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className={selectClassName}
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
          <div className="space-y-1.5">
            <label htmlFor="issue-assignee" className="text-sm font-medium">
              Assign to agent
            </label>
            <select
              id="issue-assignee"
              name="assigneeAgentId"
              defaultValue={issue.assigneeAgentId ?? ''}
              className={selectClassName}
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

        <div className="flex justify-end pt-2">
          <SaveButton />
        </div>
      </form>
    </div>
  );
}
