# Chat Thread Agent ID Backfill Investigation

## Problem Statement

The backfill script `scripts/backfill-chat-thread-agent-ids.ts` failed on TEST with:
```
column "ownerId" does not exist on mastra_threads
```

## Real Schema (TEST Production)

The `mastra_threads` table has these columns:
- `id` (string)
- `resourceId` (string)
- `title` (string, nullable)
- `metadata` (jsonb)
- `createdAt` (timestamp)
- `updatedAt` (timestamp)
- `createdAtZ` (timestamp with timezone)
- `updatedAtZ` (timestamp with timezone)

**No `ownerId` column exists.**

## TEST Data Snapshot (92 chat threads)

- **18 threads** already have `metadata.agentId` set (created after commit a9a59c7)
- **74 untagged threads** by `resourceId` kind:
  - `agent=19` — agent idle threads (e.g., `agent-durable-{agentId}`, `agent-harness-{agentId}`)
  - `board=2` — unknown board-related threads
  - `heartbeat=34` — heartbeat/issue threads (e.g., `{issueId}:{agentId}`)
  - `issue=18` — issue-related threads
  - `other=1` — unknown pattern

## Thread ID Patterns (from codebase analysis)

### Chat Threads (In Scope)

| Pattern | Format | Inference | Source |
|---------|--------|-----------|--------|
| Chat session with agent | `resourceId: company-{companyId}:chat:free`<br>`id: company-{companyId}:chat:free` | **Cannot infer** — company-scoped, not agent-scoped | `buildChatResourceId()` |
| Chat with context | `resourceId: company-{companyId}:chat:{contextType}:{contextId}`<br>`id: company-{companyId}:chat:{contextType}:{contextId}` | **Cannot infer** — company-scoped | `buildChatResourceId()` |
| Chat with scope | `id: {resourceId}::{scope}` | **Cannot infer** — scope doesn't contain agent | `getChatSession()` |

### Heartbeat Threads (Out of Scope)

| Pattern | Format | Inference | Source |
|---------|--------|-----------|--------|
| Issue thread | `{issueId}:{agentId}` | **Can infer** agentId (after `:`) | `buildHeartbeatMemoryKeys()` |
| Inbox thread | `{companyId}:{agentId}:inbox` | **Can infer** agentId (middle segment) | `buildInboxThreadId()` |
| Durable idle | `agent-durable-{agentId}` | **Can infer** agentId (after prefix) | `buildAgentIdleThreadId()` |
| Harness idle | `agent-harness-{agentId}` | **Can infer** agentId (after prefix) | `buildHarnessIdleThreadId()` |
| Legacy harness | `agent-{agentId}` | **Can infer** agentId (after prefix) | Legacy cleanup code |

## Inference Strategy

### Chat-Only Scope (Implemented)

**Scope**: Only report on chat threads where `resourceId` contains `:chat:`

**Behavior**:
1. If `metadata.agentId` exists → report as "already tagged"
2. Extract from `resourceId` pattern:
   - `company-{companyId}:chat:*` → **cannot infer** (company-scoped by design)
3. Result: Most chat threads remain untagged (expected behavior per commit a9a59c7 comments)

**Rationale**:
- Chat threads are intentionally company-scoped (per `buildChatResourceId` comment: "not by agent")
- The `ownerId` column does not exist in `mastra_threads` on TEST
- Only threads created after a9a59c7 have `metadata.agentId` 
- Untagged threads fall back to "Older shared chats" UI (working as designed)
- Heartbeat/issue threads are not chat UX surfaces

## Implementation

### Script Behavior

The script is **report-only** and does not write to the database:

1. **Filter to chat threads**: `WHERE "resourceId" LIKE '%:chat:%'`
2. **Report from existing metadata**: Check `metadata.agentId` only
3. **No writes**: Script never modifies the database (DRY_RUN is irrelevant)
4. **Agents table check**: Verify `agents` table exists for future validation
5. **Clear reporting**: Count already-tagged vs. cannot-infer (both are success states)

### Exit Behavior

| Scenario | Action | Exit Code |
|----------|--------|-----------|
| Thread has `metadata.agentId` | Report "already tagged" | 0 |
| Chat thread without agentId | Report "cannot infer" | 0 (not an error) |
| `mastra_threads` table missing | Early return | 0 (expected) |
| `agents` table missing | Report, continue | 0 (early schema) |
| DB connection error | Log error | 1 |
| Missing `DATABASE_URL` | Error | 1 |

### Which resourceId Kinds Are In/Out of Scope?

**In Scope (Chat Threads)**

- `company-{companyId}:chat:free`
- `company-{companyId}:chat:{contextType}:{contextId}`

Filtered by: `WHERE "resourceId" LIKE '%:chat:%'`

**Out of Scope (Heartbeat Threads)**

These are **not displayed in chat UI** and excluded from backfill:

- `{issueId}:{agentId}` (issue threads)
- `{companyId}:{agentId}:inbox` (inbox threads)
- `agent-durable-{agentId}` (durable idle)
- `agent-harness-{agentId}` (harness idle)
- `agent-{agentId}` (legacy harness)

Rationale: Script is for **chat** reporting; heartbeat threads are internal wake loop state.

## Tests

### Safety Requirements

Tests must **not** be destructive to shared TEST databases:

1. **Require explicit allow**: `ALLOW_DESTRUCTIVE_BACKFILL_TESTS=1` before any DROP/CREATE
2. **Document requirement**: Test file header warns about destructive operations
3. **Refuse shared DBs**: Skip destructive setup if database looks non-empty or production

### Test Coverage

- Thread with `metadata.agentId` → skip (already tagged)
- Chat thread without agentId → report as "cannot infer" (not an error)
- Agents table missing → skip validation gracefully
- Empty table → exit 0 (no threads to process)
- Table doesn't exist → exit 0 (expected if no chat sessions)
- Real column names (`resourceId` not `resource_id`)
- No `ownerId` references

## Product Outcome

The script correctly reports on the real `mastra_threads` schema:
- Chat threads are company-scoped (by design)
- No ownerId column exists on TEST
- Untagged threads appear in "Older shared chats" (expected UX)
- First message in shared thread tags it to active agent
