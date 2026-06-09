# SKILL: Plan to Tasks

This skill describes how to decompose a goal or project into a structured task tree, then create those tasks in the control plane.

---

## §1 — When to Use This Skill

Apply this skill when:
- You receive a new goal or initiative and need to create actionable work
- A project has no child issues and needs to be broken down
- A large task needs parallel sub-tasks delegated to specialist agents

---

## §2 — Planning Hierarchy

```
Goal (strategic objective, 4–12 week horizon)
  └─ Project (coherent deliverable, 1–4 week horizon)
       └─ Issue (concrete unit of work, 1–5 day horizon)
            └─ Sub-issue (delegated fragment, <1 day)
```

---

## §3 — The Decomposition Procedure

1. **Understand the goal** — call `getGoalDetail` to read the full goal description and existing linked issues
2. **Identify workstreams** — list the parallel tracks of work needed (engineering, research, design, etc.)
3. **Write a plan document** — call `putPlanDocument` with a markdown plan covering: objective, workstreams, dependencies, success criteria (when working from an assigned planning issue)
4. **Create issues top-down** — first-layer issues under a goal: call `createIssue` with `goalId` (parentId optional). Sub-issues: call `createSubtask` with `parentId` and `goalId`
5. **Assign roles** — enable the **Agent roster** toolset (or call `listAgents`) to match agent roles to issue types. Do not create issues without an assignee unless intentionally backlogging
6. **Set dependencies** — use `blockedByIssueIds` to encode sequencing. Visualise the DAG before creating issues to avoid cycles
7. **Update parent status** — after subtasks are created, set parent to `in_review` or `in_progress` as appropriate

---

## §4 — Issue Quality Standards

Every issue must have:
- A **title** that states the outcome, not the activity (e.g. "Users can reset password" not "Implement password reset")
- A **description** with: context, acceptance criteria, and relevant constraints
- A **goalId** (required). **parentId** required for sub-issues via `createSubtask`; optional for top-level issues via `createIssue`
- A **priority** level
- An **assigneeAgentId** (or explicit backlog decision)

---

## §5 — Anti-Patterns to Avoid

- Do not create more than 15 top-level issues per planning session — break into phases
- Do not create issues with identical titles — check inbox and existing issues first
- Do not assign work outside an agent's role — respect the org chart
- Do not create issues if you lack permission to assign — escalate to CEO agent
