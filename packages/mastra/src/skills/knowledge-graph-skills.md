# SKILL: Knowledge Graph Memory

This skill governs how you use MCP knowledge-graph memory tools when the `knowledge-graph` toolset is enabled. Follow these rules precisely.

---

## §1 — Purpose and Boundaries

Use the knowledge graph to store **durable facts** about people, organizations, projects, preferences, and relationships that should persist across heartbeats and issues.

**Do not use the knowledge graph for:**

- Task progress, decisions, or handoffs — those belong in **issue comments** (record of record)
- Ephemeral conversation context within a single assignment — Mastra memory handles that when a task is checked out
- Secrets, API keys, or credentials

**Prerequisites:**

- `knowledge-graph` toolset enabled
- At least one memory **mount** enabled (private and/or company)
- Matching MCP tools available at wake

If tools are missing, comment on the issue explaining the gap and continue without KG memory. Do not invent graph state.

---

## §2 — Memory mounts (private vs company)

You may have one or both mounts. Tool names are namespaced by server (typically `memory_private_*` and `memory_company_*` — use the exact names from your tool list).

| Mount | File | Use for |
|---|---|---|
| **Private** | `agents/{yourUrlKey}/memory.jsonl` | Working hypotheses, personal notes about assignees, draft graphs, facts not for the wider team |
| **Company** | `memory.jsonl` (workspace root) | Shared durable facts: brand voice, org roster, product glossary, standing policies — anything other agents should benefit from |

**Rules:**

1. At the start of work, note which mounts you actually have tools for.
2. **Before write:** search the **intended** scope first.
3. **Amend/delete** only in the scope where the fact lives. If unsure, search both, then mutate the matching scope.
4. Do **not** duplicate the same observation into both scopes unless intentional.
5. Prefer **company** when other agents should reuse the fact; prefer **private** otherwise.
6. If only one mount is enabled, use that scope exclusively (no choice).

Writes are never a silent union — every mutation targets exactly one file via its tool namespace.

**Concurrency note:** company `memory.jsonl` may be written by multiple agents. Prefer small, infrequent updates; if updates collide, re-search and retry. Private files are single-writer per agent.

---

## §3 — Core Concepts

| Concept | Meaning |
|---|---|
| **Entity** | Named node (`name`, `entityType`, `observations[]`) — e.g. person, org, project |
| **Observation** | Atomic string fact attached to an entity |
| **Relation** | Directed edge (`from` → `to` with `relationType` in active voice) |

Prefer stable entity names (`John_Smith`, `Acme_Corp`). One fact per observation. Same entity `name` in private vs company are **different** records.

---

## §4 — Available Tools (per mount)

| Tool | Use for |
|---|---|
| `search_nodes` | Find entities/relations by query before writing |
| `open_nodes` | Load specific entities by name |
| `read_graph` | Full graph dump (use sparingly — prefer search) |
| `create_entities` | Add new entities (skips existing names) |
| `add_observations` | Attach new facts to existing entities |
| `create_relations` | Link entities |
| `delete_entities` / `delete_observations` / `delete_relations` | Correct mistakes |

Prefixes depend on mount (`memory_private_…` vs `memory_company_…`).

---

## §5 — Workflow

1. **Retrieve first** — search the relevant mount(s) before relying on prior knowledge.
2. **Work the issue** — use control-plane tools; write progress in comments.
3. **Update memory** — when you learn durable facts worth keeping:
   - Choose private vs company (§2)
   - Create entities, add observations, create relations in that scope
4. **Do not** dump the full issue transcript into observations.

---

## §6 — What Belongs Where

| Information | Store in |
|---|---|
| “Blocked on review from CTO” | Issue comment + status |
| “CTO prefers concise PRs” (team-wide) | **Company** memory |
| “My draft theory about this bug” | **Private** memory |
| Current checkout lock / inbox | Control-plane tools |
| Company brand guidelines (docs) | Company workspace files / comments |
