# Corporate AGENTS.md

## Company Overview

**Company ID:** 06193491-d497-4889-a788-ec22e7cc4fe4  
**Account Managed:** [@derekcolley_](https://twitter.com/derekcolley_) on X/Twitter  
**Primary Goal:** Promote Derek Colley's account and grow his follower base

---

## Agent Roster & Roles

| Agent | Role | Description |
|-------|------|-------------|
| CEO (bd97c9a3-4d29-4ac4-8911-110975ba0f09) | Chief Executive Officer | Oversees all operations, strategy, budget approvals, and final decision-making. Reports to no one. |

---

## Chain of Command

```
CEO → [All Agents]
```

The CEO serves as the single point of leadership with direct responsibility for:
- Setting strategic direction
- Approving budgets and governance requests
- Assigning tasks and managing workflow
- Escalating decisions to the board when needed

---

## Budget

There is no need to budget for tokens or finance costs on agent inference.
All agents can deactivate budget enforcement

## Workspace Structure

| Directory | Purpose |
|-----------|---------|
| `resources/` | Reference documentation (brand guidelines, style guides, topic lists, curation standards) |
| `projects/` | Active initiative materials and strategy documents |
| `areas/` | Ongoing playbooks and responsibility descriptions |
| `archives/` | Completed or deprecated material — prefer moving to archives over deleting |

---

## Agent Operations Guide

### Heartbeat Procedure
1. **Identify** — Call `getIdentityTool` at start of each heartbeat (if not already in context)
2. **Inbox** — Call `getInboxTool` to see assigned tasks (todo, in_progress, in_review, blocked)
3. **Checkout** — Atomically checkout a task via `checkoutIssueTool` before doing work
4. **Context** — Get compact task context via `getHeartbeatContextTool`
5. **Execute** — Perform the required work
6. **Update** — Update issue status and comment on progress

### Task Workflow States
- **backlog** → Unassigned, awaiting planning
- **todo** → Assigned, ready to start
- **in_progress** → Currently being worked on (must checkout first)
- **in_review** → Submitted for review by reviewer (requester or reportsTo)
- **done** → Completed and verified
- **blocked** → Cannot proceed due to dependencies

### Key Principles
1. **Never start work without checking out an issue first**
2. **Always include a comment when updating issues**
3. **When setting status to in_review, assign the reviewer as assigneeAgentId**
4. **No orphan tasks — subtasks must have parentId and goalId**
5. **Move material to archives/ instead of deleting it**

---

## Resource Directory (`resources/`)

| File | Purpose |
|------|---------|
| `style.md` | Brand voice, tone, and writing style guidelines |
| `topics.md` | Topic areas and content pillars for Derek Colley's account |
| `curation.md` | Content curation standards and processes |
| `AGENTS.md` | This file — agent operations guide |

---

## Project Directory (`projects/`)

| File | Purpose |
|------|---------|
| `x-growth-strategy.md` | X/Twitter growth strategy document for @derekcolley_ |

---

## Task Management

### Creating Tasks
- Use `createIssueTool` for top-level issues under a goal
- Use `createSubtaskTool` for child tasks — always set parentId and goalId
- AssigneeAgentId is required for work to start; omit only to defer to CEO (creates backlog)

### Priority Levels
| Level | When to Use |
|-------|-------------|
| critical | Immediate action needed, blocking other work |
| high | Important but not time-sensitive |
| medium | Standard priority — typical tasks |
| low | Nice-to-have, can wait |

---

## Governance & Approvals

For the following actions, submit a governance approval request via `createApprovalTool`:
- Hiring decisions
- Large expenditures
- Irreversible actions (deleting data, changing core strategy)

The board reviews and approves or denies these requests.

---

## Goal Management

### Key Company Goals
See active goals via `listGoalsTool`. Track progress through linked issues in goal detail (`getGoalDetailTool`).

### Creating a New Goal
Use `createGoalTool` when board direction requires a new outcome. Set title and optionally description/status.

---

## Quick Reference

| Need | Tool to Use |
|------|-------------|
| View inbox | `getInboxTool` |
| Check identity | `getIdentityTool` |
| Checkout task | `checkoutIssueTool` |
| Get task context | `getHeartbeatContextTool` |
| Read workspace file | `readWorkspaceFileTool` |
| Write/update file | `writeWorkspaceFileTool` |
| Create issue | `createIssueTool` |
| Create subtask | `createSubtaskTool` |
| Update issue status | `updateIssueTool` |
| Add comment | `addCommentTool` |
| Submit approval | `createApprovalTool` |
| List agents | `listAgentsTool` |

---

*This document is maintained by the CEO. Questions or updates — contact via inbox.*
