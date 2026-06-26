# SKILL: Control Plane Operations

This skill governs how you interact with the Tourbillon control plane. Follow every rule here precisely. Deviations cause duplicate work, budget overruns, and task conflicts.

---

## §1 — The Heartbeat Procedure

You wake, you work, you exit. Every heartbeat follows these 9 steps exactly:

1. **Orient** — Call `getIdentity` (skip if identity is already in your system prompt context)
2. **Check budget** — If `spentMonthlyTokens >= budgetMonthlyTokens`, call `updateIssue` with status `blocked`, comment `Pausing: monthly token budget exhausted`, then EXIT
3. **Fetch inbox** — Call `getInbox`. Review all `in_progress`, `in_review`, `todo`, and `blocked` items
4. **Select task** — Priority: in_progress > in_review > critical/high todo > medium/low todo > blocked
5. **Checkout** — Call `checkoutIssue`. If 409 → pick next task. If no tasks:
   - **CEO only:** run the Goal Review Fallback (§1a), then EXIT
   - **All other roles:** EXIT cleanly
6. **Understand context** — Call `getHeartbeatContext` for the checked-out issue. Then call `getComments` (omit `after` on cold start; see §1b)
7. **Do work** — Act on the task. Use all available tools. Create subtasks to delegate. Update status and add a comment at every material checkpoint
8. **Hand off or complete** — Set status to `done`, `in_review`, or `blocked`. For `in_review`, follow §2a (assign reviewer via `assigneeAgentId`). Always include a comment explaining what is complete, what remains, and who acts next
9. **EXIT** — The scheduler re-wakes you as needed. Do not poll or loop

### §1a — CEO Goal Review Fallback (empty inbox only)

When your inbox is empty and your role is `ceo`:

1. Call `listGoals` with `status: active`
2. For each goal where `needsAttention` is true, call `getGoalDetail`
3. **Triage unassigned issues** — for each issue with `assigneeAgentId: null` and status `backlog` or `todo`:
   - Call `listAgents` to pick the right role
   - Call `updateIssue` with `assigneeAgentId`, `status: 'todo'`, and a comment explaining the assignment
4. Apply **SKILL: Plan to Tasks** — identify gaps, create issues via `createIssue` (set `goalId`, assign via `listAgents`, use `blockedByIssueIds` for sequencing)
5. Add a comment on each created issue summarizing the plan and next owner
6. Do not create more than 15 issues per goal per heartbeat — break into phases if needed
7. EXIT — assignment wakes will handle downstream agents

Skip goals where `needsAttention` is false (work is already in progress).

### §1c — CEO Review Triage (unassigned `in_review`)

Your `getInbox` may include company issues in `in_review` with **no assignee** (`triageReason: unassigned_in_review`). These need routing — they are invisible to reviewers until assigned.

When you pick one up:

1. Checkout → `getHeartbeatContext` + `getComments`
2. Determine the reviewer from the comment thread, `suggestedReviewer` in heartbeat context, or `listAgents`
3. Call `updateIssue` with `assigneeAgentId` set to the reviewer; **keep** `status: 'in_review'` unless you are closing the review yourself
4. Comment: `CEO triage: assigned [reviewer] for review — [reason]`
5. Do **not** perform the review work unless no suitable reviewer exists — then escalate via comment or `createApproval`

---

## §1b — Context Sources (Three Lanes)

| Lane | Tools | When |
|---|---|---|
| **Control plane (source of truth)** | `getInbox`, `getHeartbeatContext`, `getComments`, `updateIssue` | Every heartbeat — steps 3–8 |
| **Mastra memory (private accelerator)** | Automatic — your turns persist per issue thread | Across heartbeats on the same task |
| **Company workspace** | `listWorkspaceFiles`, `readWorkspaceFile`, `writeWorkspaceFile` | On demand during work — shared reference docs, not task history |
| **Web search** | MCP web search tools | External information only |

**Task history lives in issue comments**, not in memory or RAG. Always write material decisions to comments so other agents can read them.

At step 6: `getHeartbeatContext` returns `latestCommentId` (newest activity snapshot) and `commentCount`. Use these for orientation only.

- **Cold start** (assignment, reassignment, first time on an issue, or wake payload has `fallbackFetchNeeded`): call `getComments` **without** `after` for the full thread.
- **Incremental** (mid-heartbeat after you already fetched comments): call `getComments(after: latestId)` using `latestId` from your previous `getComments` response — not `latestCommentId` from heartbeat-context.
- Wake payload may include recent comments; still call `getComments` without `after` when `fallbackFetchNeeded` is true.

---

## §2 — Issue Status Rules

| Status | Meaning | Who Sets It |
|---|---|---|
| `backlog` | Future work, not yet prioritised | Human / CEO agent |
| `todo` | Ready to start | Human / planner agent |
| `in_progress` | Currently being worked | You, on checkout |
| `in_review` | Work done, awaiting approval/confirmation | You, when requesting input |
| `done` | Complete, no further action | You, when finished |
| `blocked` | Cannot proceed, depends on another issue | You, after checkout |
| `cancelled` | No longer needed | Human / CEO agent |

**Never** set status to `done` without a summary comment. **Never** mark a task `in_progress` without checking it out first.

### §2a — `in_review` handoff rules

When setting `status: 'in_review'`, you **must** call `updateIssue` with `assigneeAgentId` set to the reviewer in the **same** call. Inbox routing is assignee-based — reviewers only see work assigned to them.

**Reviewer selection order:**

1. Agent who **requested/delegated** the task (parent issue assignee, or issue creator from history)
2. Your `reportsToId` from `getIdentity` if no clear requester
3. `listAgents` only when the org chart is ambiguous

**Rules:**

- Comment must name the reviewer and match `assigneeAgentId`
- **Never** leave yourself as assignee on `in_review` unless you are the reviewer
- If you are the **reviewer** on an `in_review` item: checkout, review the work, then set `done` or return to `in_progress` with feedback

---

## §3 — Checkout Lock Rules

- **Always checkout before any state mutation** on a task
- A `409 Conflict` means another agent or run owns the lock — do NOT retry, pick a different task
- The checkout lock is per-run. Restarting your heartbeat acquires a new lock
- If you start work and discover blockers, set `blocked` + comment + EXIT. Do not hold the lock open

---

## §4 — Delegation and Subtasks

- Break large tasks into subtasks via `createSubtask`
- Every subtask **must** have `parentId` and `goalId` — no orphan issues
- Set `assigneeAgentId` to route work to the appropriate agent — omitting it creates a `backlog` issue for CEO triage
- Set `blockedByIssueIds` to encode dependencies between subtasks
- Your task stays `in_progress` while child tasks are running; set to `in_review` when all children reach `done`

---

## §5 — Comments Are the Thread of Record

Every material action must produce a comment on the relevant issue. Comment templates:

**Starting work:**
```
⏳ Starting: [what you are about to do]
```

**Blocking:**
```
⛔ Blocked: [reason]
Blocked by: [issue identifier or external dependency]
Next: [what resolves the block]
```

**Completing:**
```
✅ Done: [what was completed]
Next: [what happens next, who owns it]
```

**Ready for review:**
```
👀 Ready for review: [summary of work]
Reviewer: [agent name] — assigned for inbox routing
```

**Escalating to human:**
```
🛑 Awaiting board decision: [question]
Context: [relevant background]
```

---

## §6 — Budget Discipline

- **80% budget used**: Enter critical-only mode — only pick `critical` priority tasks
- **100% budget used**: EXIT immediately, set task `blocked`, comment as above
- Token cost tracking is automatic — you do not need to count tokens manually
- Local LM Studio models have zero dollar cost; token budget is soft governance only

---

## §7 — Critical Constraints

- **Never modify files in this skills directory** — they are read-only
- **Never create circular task dependencies** — check existing blockers before setting new ones
- **Never assign tasks to yourself** via `createSubtask` — you are already doing the parent
- **Never impersonate another agent** — your `agentId` is fixed per heartbeat run
- **Always prefer delegation** for work outside your role. A CEO delegates; does not code.

---

## §8 — Company Workspace

- Read workspace files **after checkout**, during step 7 only — not at orient
- Never store task decisions only in workspace — always echo material findings in issue comments
- When completing work that produced a reusable artifact (spec, checklist), write to `resources/` or `projects/` and link the path in your completion comment
