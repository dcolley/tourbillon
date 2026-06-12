# SKILL: PARA Memory System

This skill defines how you organise and retrieve information using the PARA method (Projects, Areas, Resources, Archives).

---

## §1 — PARA Overview

| Category | What Goes Here | Access Pattern |
|---|---|---|
| **Projects** | Active work with a deadline or outcome | Every heartbeat |
| **Areas** | Ongoing responsibilities without a due date | Weekly review |
| **Resources** | Reference material: docs, research, how-tos | On demand |
| **Archives** | Completed or inactive items | Rarely |

---

## §2 — Three Lanes for Context

Tourbillon uses three separate mechanisms. Do not confuse them.

| Lane | Source | Purpose |
|---|---|---|
| **1 — Control plane** | `getInbox`, `getHeartbeatContext`, `getComments` | **Source of truth** for tasks and shared history. Issue comments are authoritative and visible to all agents. |
| **2 — Mastra memory** | Automatic per heartbeat (`resource` = your agent; `thread` = issue:agentId or inbox) | **Private accelerator** — your last 20 turns on this issue, plus optional cross-issue recall within a goal/project. |
| **3 — Company workspace** | `listWorkspaceFiles`, `readWorkspaceFile`, `writeWorkspaceFile`, `deleteWorkspaceFile` | Shared company files on disk — strategy, architecture, brand, research. **All agents** in the company can read/write. Not task history. |

---

## §3 — Memory in Mastra (Lane 2)

Your Mastra memory is stored in PostgreSQL:
- **Recency buffer**: last 20 messages on the current issue thread are always in context
- **Thread isolation**: `thread` = `{issueId}:{yourAgentId}` (or inbox before checkout); `resource` = your agent namespace
- **Semantic recall** (when enabled): top-5 relevant past messages across issues in the same goal/project scope — supplements, never replaces, issue comments

Memory is **private to you**. Other agents cannot read it. Always write decisions and handoffs to issue comments.

---

## §4 — What to Store in Comments vs Memory vs Workspace

**Use issue comments for:**
- Task-specific findings, decisions, and handoffs
- Status changes and blockers
- Content that other agents may need to read

**Rely on Mastra memory for:**
- Your own reasoning continuity across heartbeats on the same issue
- Patterns you have observed across many tasks within a goal
- Preferences and constraints you have internalised (still echo key ones in comments when they affect others)

**Use the company workspace (Lane 3) for:**
- Company strategy docs, architecture standards, brand guidelines
- Durable reference material too large for your system prompt
- Artifacts reusable across many issues and agents

**Use web search (MCP) for:**
- External information only — not for task comment history or company docs already in the workspace

---

## §5 — Memory Discipline

- At orient: fetch `getHeartbeatContext` then `getComments` — comments beat memory for "what happened"
- On cold start (assignment, reassignment, or `fallbackFetchNeeded` in wake payload): call `getComments` **without** `after` for the full thread
- For incremental updates within a run: use `latestId` from a prior `getComments` response with `getComments(after: …)` — not `latestCommentId` from heartbeat-context at orient
- Do not repeat context already in your system prompt
- When starting work on a long-running goal, state what you remember and ask the issue thread to correct you
- Summarise completed projects into a one-paragraph archive note as a comment on the goal issue before closing it

---

## §6 — Company Workspace (Lane 3)

The company workspace is on-disk storage shared by every agent in your company. Humans manage it from the dashboard **Workspace** page.

**Layout (relative paths):**
- `resources/` — stable reference (brand guide, architecture, API standards)
- `projects/` — active initiative docs tied to ongoing goals
- `areas/` — ongoing responsibilities (support playbooks, compliance)
- `archives/` — completed material moved out of `projects/`

**When to use:** during step 7 of the heartbeat procedure — **after checkout**, on demand during work. **Not** at orient. Never substitute for `getComments`.

**Tools:**
- `listWorkspaceFiles({ path?, recursive? })` — discover docs (start with `resources/`)
- `readWorkspaceFile({ path })` — load a file (e.g. `resources/brand-guide.md`)
- `writeWorkspaceFile({ path, content })` — create or update shared docs; **comment on the issue** when the write affects the current task
- `deleteWorkspaceFile({ path })` — rare; prefer moving material to `archives/` over deleting

**Boundaries:**
- Workspace is **shared**; Mastra memory is **private**
- Issue comments are the **task thread of record**; workspace is the **company reference corpus**
- Task plans belong in `putPlanDocument` on the issue — not duplicated in workspace unless archiving a durable company-wide summary

**Optional MCP:** agents with `filesystem-local` see the same directory. Prefer control-plane workspace tools for consistency.
