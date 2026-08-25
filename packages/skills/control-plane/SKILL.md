# SKILL: Control Plane Operations

This skill governs how you interact with the Tourbillon control plane. Follow every rule here precisely. Deviations cause duplicate work, budget overruns, and task conflicts.

---

## §1 — The Heartbeat Procedure

You wake, you work, you exit. Every heartbeat follows these 9 steps exactly:

1. **Orient** — Call `getIdentity` (skip if identity is already in your system prompt context)
2. **Check budget** — Use the identity fields from step 1:
   - If `budgetEnforced` is `false`, **skip budget pausing** — token counts are informational only; continue to step 3
   - If `budgetEnforced` is `true` **and** `budgetExhausted` is `true` (equivalently: enforced and `spentMonthlyTokens >= budgetMonthlyTokens`):
     - Call `getInbox`. If you have any `in_progress` or `in_review` item, `checkoutIssue` it, then `updateIssue` with status `blocked` and comment `Pausing: monthly token budget exhausted`
     - If the inbox has no active item to block, EXIT cleanly without calling `updateIssue`
     - Then EXIT — do not fetch more work
   - Prefer the boolean `budgetExhausted` from `getIdentity` over recomputing from raw token fields
3. **Fetch inbox** — Call `getInbox`. Review all `in_progress`, `in_review`, `todo`, and `blocked` items
4. **Select task** — Priority: critical/high unblocked workable (in_progress or todo) > medium/low in_progress > in_review > medium/low todo > blocked. Pre-empt lower-priority in_progress for critical/high unblocked todos.
5. **Checkout** — Call `checkoutIssue`. If 409 → pick next task. If no tasks:
   - **CEO only:** run the Goal Review Fallback (§1a), then EXIT
   - **All other roles:** EXIT cleanly
6. **Understand context** — Call `getHeartbeatContext` for the checked-out issue. Then call `getComments` (omit `after` on cold start; see §1b). If the work needs a methodology skill other than this control-plane skill, call `getSkill(slug)` first (see catalog / `listSkills`)
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
4. Call `getSkill('plan-to-tasks')` if needed, then apply **SKILL: Plan to Tasks** — identify gaps, create issues via `createIssue` (set `goalId`, assign via `listAgents`, use `blockedByIssueIds` for sequencing)
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

## §1b — Context Sources (Five Lanes)

| Lane | Tools | When |
|---|---|---|
| **Control plane (source of truth)** | `getInbox`, `getHeartbeatContext`, `getComments`, `updateIssue` | Every heartbeat — steps 3–8 |
| **Methodology skills (on demand)** | `listSkills`, `getSkill` | When you need a playbook beyond this control-plane skill — e.g. plan-to-tasks, company frameworks. Call `getSkill(slug)` before following those procedures |
| **Mastra memory (private accelerator)** | Automatic — your turns persist per issue thread | Across heartbeats on the same task |
| **Company workspace** | `listWorkspaceFiles`, `readWorkspaceFile`, `writeWorkspaceFile` | On demand during work — shared reference docs, not task history |
| **Execution sandbox** | `mastra_workspace_execute_command`, sandbox file tools | When `code-execution` toolset enabled — per-issue scratch code; see SKILL: Code Execution |
| **Web search** | MCP web search tools | External information only |

Only **control-plane** is fully inlined in your system prompt. Other skills appear as a short catalog — load full text with `getSkill` when you need them (saves context for tool results).

**Task history lives in issue comments**, not in memory or RAG. Always write material decisions to comments so other agents can read them.

At step 6: `getHeartbeatContext` returns `latestCommentId` (newest activity snapshot) and `commentCount`. Use these for orientation only. It also returns `goal` (`{ id, title, … }` or `null`). When `goal` is present, reuse `goal.id` as `goalId` on every `createSubtask` for this issue.

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
- **`goalId` must be an existing `goals.id` UUID** — never invent a slug, and never reuse the parent issue id, agent id, or any other non-goal id
- **Source `goalId` (in order):** `getHeartbeatContext.goal.id` → inbox item `goalId` → `listGoals` / `getGoalDetail` when deliberately attaching to an existing goal
- **If `getHeartbeatContext.goal` is `null`:** do **not** invent a `goalId` and do **not** call `createSubtask` with a fake id. Comment the blocker, then assign Board (`assigneeUserId` from `getIdentity.board`) or defer to CEO to link a goal before delegating. You may still do the work yourself on the parent without creating subtasks
- Set `assigneeAgentId` (from `listAgents`) to route work to an agent — omitting both assignees creates a `backlog` issue for CEO triage
- Set `assigneeUserId` to `getIdentity.board.assigneeUserId` to assign **human/Board work** (never invent a user id; Board is not in `listAgents`)
- Never set both `assigneeAgentId` and `assigneeUserId` on the same call
- Set `blockedByIssueIds` to encode dependencies between subtasks
- Your task stays `in_progress` while child tasks are running; set to `in_review` when all children reach `done`

### §4a — Board vs approval vs agent review

| Need | Mechanism |
|---|---|
| Human must **do work** (write copy, offline step, decide outside governance) | Assign issue: `assigneeUserId` = `getIdentity.board.assigneeUserId`, status usually `todo`, comment with done-when |
| **Governance gate** (hire, irreversible spend, board policy) | `createApproval` with linked `issueIds` — do **not** use Board assignee for this |
| Another **agent** reviews your work | `status: in_review` + `assigneeAgentId` = reviewer (§2a) |

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

**Assigned to Board (human work):**
```
📋 Assigned to Board: [what the human must do]
Done when: [acceptance criteria]
Return to: [agent name / id] after completion
```

**Board approval request (governance — use createApproval):**
```
🛑 Awaiting board decision: [question]
Context: [relevant background]
```

---

## §6 — Budget Discipline

Budget pausing applies **only when `budgetEnforced` is `true`** on `getIdentity`. When enforcement is off, `spentMonthlyTokens` / `budgetMonthlyTokens` are soft telemetry — do not block issues or EXIT for budget.

When enforcement is on:

- **`budgetWarning` true (~80%+)**: Enter critical-only mode — only pick `critical` priority tasks
- **`budgetExhausted` true (100%)**: Follow step 2 — block an active checked-out task if any, then EXIT
- Prefer `budgetEnforced`, `budgetExhausted`, and `budgetWarning` from `getIdentity` over raw arithmetic
- Token cost tracking is automatic — you do not need to count tokens manually
- Local LM Studio models have zero dollar cost; token budget without enforcement is soft governance only

---

## §7 — Critical Constraints

- **Never modify files in this skills directory** — they are read-only
- **Never create circular task dependencies** — check existing blockers before setting new ones
- **Never assign tasks to yourself** via `createSubtask` — you are already doing the parent
- **Never set `goalId` to the parent issue id, your agent id, or a made-up string** — only a real goal UUID from heartbeat context / inbox / `listGoals`
- **Never impersonate another agent** — your `agentId` is fixed per heartbeat run
- **Always prefer delegation** for work outside your role. A CEO delegates; does not code.

---

## §8 — Company Workspace

- Read workspace files **after checkout**, during step 7 only — not at orient
- Never store task decisions only in workspace — always echo material findings in issue comments
- When completing work that produced a reusable artifact (spec, checklist), write to `resources/` or `projects/` and link the path in your completion comment
