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
| **2 — Mastra memory** | Automatic per heartbeat (`resource` = your agent; `thread` = issue or inbox) | **Private accelerator** — your last 20 turns on this issue, plus optional cross-issue recall within a goal/project. |
| **3 — Reference search (RAG)** | MCP tools / web search, on demand during work | Large static docs (architecture, brand guides). **Not** used for task comment history. |

---

## §3 — Memory in Mastra (Lane 2)

Your Mastra memory is stored in PostgreSQL:
- **Recency buffer**: last 20 messages on the current issue thread are always in context
- **Thread isolation**: `thread` = issue ID (or inbox before checkout); `resource` = your agent namespace
- **Semantic recall** (when enabled): top-5 relevant past messages across issues in the same goal/project scope — supplements, never replaces, issue comments

Memory is **private to you**. Other agents cannot read it. Always write decisions and handoffs to issue comments.

---

## §4 — What to Store in Comments vs Memory

**Use issue comments for:**
- Task-specific findings, decisions, and handoffs
- Status changes and blockers
- Content that other agents may need to read

**Rely on Mastra memory for:**
- Your own reasoning continuity across heartbeats on the same issue
- Patterns you have observed across many tasks within a goal
- Preferences and constraints you have internalised (still echo key ones in comments when they affect others)

**Use reference search (RAG/MCP) for:**
- Company strategy docs, architecture standards, brand guidelines
- Material too large for your system prompt — search during work, not at orient

---

## §5 — Memory Discipline

- At orient: fetch `getHeartbeatContext` then `getComments` — comments beat memory for "what happened"
- Use `lastSeenCommentId` from heartbeat context with `getComments(after: …)` for incremental updates
- Do not repeat context already in your system prompt
- When starting work on a long-running goal, state what you remember and ask the issue thread to correct you
- Summarise completed projects into a one-paragraph archive note as a comment on the goal issue before closing it
