# Manage Agents Skill

> **Methodology for agent management tools** — for CEO (default) and agents with `agent-management` toolset.

---

## Purpose

Agents with the `agent-management` toolset can inspect, pause, enable, archive, tune heartbeat, update profile/model/capabilities, and observe teammates. This skill teaches when to manage directly vs file board approvals, safety rules (self-pause, last CEO), and audit discipline.

---

## Tools (must have `agent-management` toolset)

| Tool | Purpose |
|------|---------|
| `getAgent` | Fetch full agent detail by ID or urlKey (on `roster` toolset) |
| `setAgentActive` | Set status: active / paused / archived |
| `setAgentHeartbeat` | Enable/disable timer; set interval or cron |
| `updateAgentProfile` | Change name, title, reportsTo, urlKey, SOUL.md, AGENTS.md |
| `updateAgentModel` | Change LLM model and/or provider |
| `updateAgentCapabilities` | Grant/revoke skills, toolsets, granular tools, MCP servers |

---

## Safety Rules

### 1. Cannot pause or archive yourself

Direct self-mutation is **forbidden** (400 response). If you need to pause/archive yourself, either:
- Use the Board UI (Dashboard → Agent detail → Active toggle / Archive), or
- File a board approval (`createApproval`) with `type: "pause_self"` or similar, explaining why.

### 2. Cannot archive or pause the last active CEO

Attempting to pause or archive the sole active CEO in the company returns a 400 error. Always leave at least one active CEO.

### 3. Privilege escalation audit

When granting **privileged capabilities** — `code-execution` toolset, new MCP servers, or toolsets the **calling agent** does not itself hold — include a **required `reason` field** in `updateAgentCapabilities`:

```json
{
  "agentId": "...",
  "assignedToolsets": ["comments", "code-execution"],
  "reason": "Engineer needs sandbox to run integration tests per Issue #42."
}
```

Omitting `reason` on a privilege grant may be rejected or flagged in observability. This is an **audit discipline**, not a board approval gate (MVP). Post-MVP, high-risk grants may require board approval.

---

## When to Manage Directly vs Board Approval

| Action | Direct (agent tool) | Board approval |
|--------|---------------------|----------------|
| Pause/enable other agents | ✅ Direct via `setAgentActive` | Optional; post a comment on linked issue |
| Pause/archive **self** | ❌ Forbidden | ✅ Use Board or `createApproval` |
| Hire new agent | ❌ Out of scope | ✅ Always board approval + `createAgent` after |
| Change routine or wakes | ✅ `setAgentHeartbeat` | Optional for high-cost routines |
| Archive agent | ✅ Direct (soft-delete; agent remains in DB) | Optional; preferred for structural changes |
| **Hard delete** agent | ❌ Not available in tools | ✅ Board only (Dashboard → Agent → Delete with confirmation) |

**Guideline:** For routine ops (pause runaway, tune heartbeat, update profile/model), use tools directly and comment on linked issues. For irreversible or company-wide impact (hiring, hard delete, granting powerful MCP servers), file board approval first.

---

## Workflow: Inspect Before You Change

Always call `getAgent` before mutation to inspect:
- Current `status` (active/paused/archived)
- Heartbeat config (`enabled`, `intervalSec`, `cronExpression`)
- `assignedToolsets` and `assignedSkills`
- `modelId` and `providerId`
- `reportsToId` and org chart

Example:

```javascript
// Step 1: Inspect
const agent = await getAgent({ urlKey: "cmo" });
console.log("Current status:", agent.status);
console.log("Heartbeat enabled:", agent.runtimeConfig.heartbeat.enabled);

// Step 2: Decide and mutate
if (agent.status === "active" && /* runaway condition */) {
  await setAgentActive({
    agentId: agent.id,
    status: "paused",
    reason: "Paused due to repeated 500 errors in heartbeat runs"
  });
}
```

---

## Archive vs Delete

| Operation | Tool | Effect | Reversible |
|-----------|------|--------|------------|
| **Archive** | `setAgentActive({ status: "archived" })` | Soft-delete; row remains in DB; hidden from `listAgents` by default | ✅ Can re-activate |
| **Hard delete** | Board only (Dashboard → Delete + confirm urlKey) | Permanent removal from DB | ❌ Irreversible |

**Prefer archive** for retired agents, agents on leave, or agents replaced by new hires. Hard delete is only for cleaning up test agents or agent duplicates.

`listAgents` hides archived agents by default; pass `includeArchived: true` to see them.

---

## Heartbeat Scheduling

Use `setAgentHeartbeat` to:
- Enable/disable automatic timer wakes
- Set interval (seconds) or cron expression (not both)
- Configure max tool steps per heartbeat

Examples:

```javascript
// Enable hourly heartbeat
await setAgentHeartbeat({
  agentId: "...",
  enabled: true,
  intervalSec: 3600
});

// Enable daily at 9am UTC
await setAgentHeartbeat({
  agentId: "...",
  enabled: true,
  cronExpression: "0 9 * * *"
});

// Disable heartbeat
await setAgentHeartbeat({
  agentId: "...",
  enabled: false
});
```

Changes persist immediately and sync the Mastra schedule. The agent will start/stop timer wakes accordingly.

---

## Profile and Instructions

Use `updateAgentProfile` to change:
- `name` (display name in UI)
- `title` (job title)
- `urlKey` (agent slug in URLs — ensure no duplicates)
- `reportsToId` (org chart manager; null to clear)
- `instructionsBundleSoulMd` (SOUL.md — personality, values, tone)
- `instructionsBundleAgentsMd` (AGENTS.md — team knowledge, per-agent version)

All fields are optional — partial updates allowed.

**Validation:** Changing `reportsToId` checks for cycles. Changing `urlKey` checks for duplicates in the company.

---

## Model and Provider

Use `updateAgentModel` to retarget an agent to a different LLM:

```javascript
await updateAgentModel({
  agentId: "...",
  modelId: "meta-llama/Llama-3.3-70B-Instruct",
  providerId: "lmstudio-default"  // optional; defaults to current provider
});
```

Model change invalidates the agent's chat controller cache. New heartbeats use the updated model.

---

## Capabilities

`updateAgentCapabilities` modifies:
- `assignedSkills` (e.g., `["control-plane", "para-memory"]`)
- `assignedToolsets` (e.g., `["roster", "comments", "code-execution"]`)
- `assignedTools` (granular tool IDs from goal/project/issue management groups)
- `mcpServerIds` (MCP servers enabled for the agent)

All arrays replace the full set (not append). To add a toolset, pass the full list including the new one.

**Escalation policy (MVP):** When granting privileged capabilities (code-execution, MCP servers, toolsets the caller lacks), include `reason`:

```javascript
await updateAgentCapabilities({
  agentId: engineerId,
  assignedToolsets: ["comments", "code-execution"],
  assignedTools: [...],
  assignedSkills: [...],
  reason: "Engineer needs sandbox for integration tests (Issue #42)"
});
```

Post-MVP, high-risk grants may require board approval. For now, `reason` is audit-only.

---

## Observability and Audit

Every management tool call is traced via Mastra observability (when `OBSERVABILITY_ENABLED=true`). Spans include:
- Tool ID (e.g., `setAgentActive`, `updateAgentCapabilities`)
- Target `agentId`
- Calling agent's `agentId` (in span context)
- Input parameters (including `reason` for capabilities)

To audit who changed what, query `agent_observability_events` or view the Observability UI timeline filtered by agent.

When changing critical settings (status, capabilities), **post a comment on linked issues** explaining the change:

```javascript
await setAgentActive({ agentId: "...", status: "paused", reason: "..." });
await addComment({
  issueId: relatedIssueId,
  body: "Paused CMO agent due to repeated API errors. Investigating."
});
```

---

## Known Limitations (MVP)

- **Hard delete** not available in tools (Board/Dashboard only).
- **Wake agent** not available in tools (Board "Wake Now" only).
- **Observational memory** (`setAgentOm`) is P2 — defer to Board settings for now.
- **Capability escalation** audit via `reason` field; board approval for high-risk grants is post-MVP.

---

## Example: Pause Runaway Agent

```javascript
// 1. Inspect current state
const cmo = await getAgent({ urlKey: "cmo" });

// 2. Check recent heartbeat runs (via getHeartbeatContext or observability)
// (Assume we found repeated failures)

// 3. Pause the agent
await setAgentActive({
  agentId: cmo.id,
  status: "paused",
  reason: "Paused due to repeated 500 errors in heartbeat runs"
});

// 4. Comment on the linked issue
await addComment({
  issueId: relatedIssueId,
  body: `Paused @${cmo.urlKey} due to repeated heartbeat failures. Logs show 500 from /api/issues/checkout. Investigating API timeout.`
});

// 5. Fix the issue, then re-enable
await setAgentActive({
  agentId: cmo.id,
  status: "active",
  reason: "Re-enabled after fixing API timeout"
});
```

---

## Summary

- **Direct management** for routine ops (pause, heartbeat, profile, model).
- **Board approval** for hiring, hard delete, high-impact changes.
- **Always inspect** with `getAgent` before mutating.
- **Cannot pause self** or archive last CEO (safety rules).
- **Audit discipline:** include `reason` for privilege grants; comment on linked issues.
- **Prefer archive** over hard delete for retired agents.

---

**Skill version:** 1.0 (2026-10-01)
