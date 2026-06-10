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
8. **Hand off or complete** — Set status to `done`, `in_review`, or `blocked`. Always include a comment explaining what is complete, what remains, and who acts next
9. **EXIT** — The scheduler re-wakes you as needed. Do not poll or loop

### §1a — CEO Goal Review Fallback (empty inbox only)

When your inbox is empty and your role is `ceo`:

1. Call `listGoals` with `status: active`
2. For each goal where `needsAttention` is true, call `getGoalDetail`
3. Apply **SKILL: Plan to Tasks** — identify gaps, create issues via `createIssue` (set `goalId`, assign via `listAgents`, use `blockedByIssueIds` for sequencing)
4. Add a comment on each created issue summarizing the plan and next owner
5. Do not create more than 15 issues per goal per heartbeat — break into phases if needed
6. EXIT — assignment wakes will handle downstream agents

Skip goals where `needsAttention` is false (work is already in progress).

---

## §1b — Context Sources (Three Lanes)

| Lane | Tools | When |
|---|---|---|
| **Control plane (source of truth)** | `getInbox`, `getHeartbeatContext`, `getComments`, `updateIssue` | Every heartbeat — steps 3–8 |
| **Mastra memory (private accelerator)** | Automatic — your turns persist per issue thread | Across heartbeats on the same task |
| **Reference search** | MCP / web search tools | On demand during work — not for task history |

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
- Set `assigneeAgentId` to route work to the appropriate agent
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
