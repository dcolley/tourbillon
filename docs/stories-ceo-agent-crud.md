# CEO Agent Management CRUD Tools

**Document Version**: 1.0  
**Last Updated**: 2026-10-01 (BST)  
**Status**: Draft — Ready for Dev / Test  
**Owner**: PM:Tourbillon (Derek)  
**Repo**: `dcolley/tourbillon` (main @ research time)

---

## Overview

CEO (and other agents authorized via agent config) need full **CRUD** Mastra tools to manage company teammates — pause/enable, heartbeat, profile, model, capabilities — gated the same way as `createAgent` (`assignedToolsets` / `assignedTools` / skills).

### Problem Statement

**Severity:** P0 for pause/enable + heartbeat + profile; P1 for model + capabilities; P2 for observational memory.

**Current State (verified on main):**

1. **Agent-facing roster** (`packages/mastra/src/tools/role-tools.ts`) exposes only:
   - `listAgents` → `GET /api/companies/{companyId}/agents` (run token)
   - `createAgent` → `POST /api/companies/{companyId}/agents` (run token)
2. **`agent-management` is a legacy alias** of the same `rosterTools` object (identical tools; not a write toolset).
3. **Tier-1 control-plane tools** have identity/inbox/issues/workspace/mail — **no agent status mutations**.
4. **ASSIGNABLE_TOOLS** (`packages/shared/src/tool-catalog.ts`) cover goals/projects/plan/confirmation only — **no agent update**.
5. **Board / ops already can manage agents**; agents cannot:
   - Dashboard server actions: `toggleAgentActiveAction`, `updateAgentRoleAction`, `deleteAgentAction`, wake (`apps/web/app/(dashboard)/agent/actions.ts`) plus agent settings UI at `/agent/[urlKey]`
   - Mobile: `PATCH /api/mobile/agents/[urlKey]` with `section` = profile | role | instructions | model | heartbeat | capabilities | active | delete | … (`requireMobileCompany` session — **not** run tokens)
   - Ops MCP (`docs/mcp-control-plane.md`, `apps/web/app/api/mcp/route.ts`): `list_agents`, `set_agent_active`, `set_heartbeat`, `set_om`, `set_agent_model`, `wake_agent` via `X-Company-Token` JWT — **not** Mastra agent tools
6. **Lib layer is largely complete** (`apps/web/lib/agents.ts`): `setAgentActive`, `updateAgentRuntimeConfig`, `updateAgentProfile`, `updateAgentModel`, `updateAgentCapabilities`, `updateAgentInstructions`, `updateAgentObservationalMemory`, `deleteAgent`, etc.
7. **Missing for agents:** run-token HTTP surface for single-agent GET/PATCH, Mastra tools wired into a write toolset, CEO defaults + skill docs, safety gates (self-pause, last CEO, privilege escalation).

### Expected Outcome

Authorized agents (CEO by default) can manage the team end-to-end during heartbeats: inspect an agent, pause/enable, tune heartbeat, edit profile/instructions, change model, adjust capabilities (with escalation policy), and soft-archive — all durable and visible in UI agent settings, traced via `tracedAgentFetch`.

### Related Links

| Resource | Path / note |
|----------|-------------|
| Create-agent stories (pattern) | `docs/stories-create-agent-tool.md` |
| MCP control plane | `docs/mcp-control-plane.md` |
| Roster / ROLE_TOOLS | `packages/mastra/src/tools/role-tools.ts` |
| Tool assembly | `packages/mastra/src/agent-factory.ts` (`assembleAgentTools`) |
| Role defaults | `packages/shared/src/constants.ts`, `packages/shared/src/tool-catalog.ts` |
| Agent lib | `apps/web/lib/agents.ts` |
| Company agents API (list/create only) | `apps/web/app/api/companies/[companyId]/agents/route.ts` |
| Mobile agent PATCH (board session) | `apps/web/app/api/mobile/agents/[urlKey]/route.ts` |
| Dashboard actions | `apps/web/app/(dashboard)/agent/actions.ts` |
| Status enum | `packages/db/src/schema/agents.ts` → `active \| paused \| archived \| pending_approval` |
| Create-agent skill | `packages/skills/create-agent/SKILL.md` |
| Follow-up open | US-CA2 (soul/agents/codeExecution on create) still REQUIRED |

---

## Context

### Auth surfaces today

| Caller | Auth | Can list | Can create | Can mutate status/config |
|--------|------|----------|------------|---------------------------|
| Mastra agent (run token) | `Authorization: Bearer <runJwt>` | ✅ | ✅ | ❌ **gap** |
| Board dashboard | Cookie / server action | ✅ | ✅ | ✅ |
| Mobile | Mobile company session | ✅ | — | ✅ section PATCH |
| Ops MCP | `X-Company-Token` company JWT | ✅ | ❌ (out of MCP scope) | ✅ active/heartbeat/model/OM/wake |

**Conclusion:** Agent run tokens **cannot** call existing mutation paths today. US-AM1 must add company-scoped run-token routes (or explicitly allowlisted reuse) before tools can ship.

### Tool assembly & gating

From `assembleAgentTools` + `ROLE_TOOLS`:

- Boolean toolsets in `assignedToolsets` bind `ROLE_TOOLS[toolsetId]`.
- Granular tools bind from `runtimeConfig.assignedTools` / role defaults.
- CEO defaults (`ROLE_DEFAULT_TOOLSETS`): `comments`, `approvals`, `roster`, `web-search`.
- CEO skills: `control-plane`, `plan-to-tasks`, `create-agent`, `para-memory`.
- CTO/PM also get `roster` (list + create today) — **mutations must not silently land on all roster holders**.

### Recommended gating (product decision — MVP)

**Split read vs write:**

| Toolset id | Tools | Who gets it by default |
|------------|-------|------------------------|
| `roster` | `listAgents`, `getAgent`, `createAgent` | CEO, CTO, PM (unchanged + getAgent) |
| `agent-management` | `setAgentActive`, `setAgentHeartbeat`, `updateAgentProfile`, `updateAgentModel`, `updateAgentCapabilities`, `setAgentOm` (P2) | **CEO only** by default; others opt-in via Capabilities |

- Keep `agent-management` as a **real** write toolset (stop aliasing to roster).
- Add `agent-management` to `TOOLSET_CATALOG` and `VALID_TOOLSET_IDS`.
- Skill: new `manage-agents` (or extend `create-agent`) — methodology only; toolset is the hard gate.

### Status & archive policy

| Status | Meaning | How set today | Agent tool (proposed) |
|--------|---------|---------------|------------------------|
| `active` | Runnable | `setAgentActive(true)` / hire | `setAgentActive({ status: "active" })` |
| `paused` | Stopped wakes | `setAgentActive(false)` | same |
| `archived` | Soft-delete / out of roster ops | **Schema exists; no dedicated lib helper via `setAgentActive`** | `setAgentActive({ status: "archived" })` — extend lib |
| `pending_approval` | Pre-hire gate | Hire flow | **Reject** agent mutations (already blocked in `setAgentActive`) |

**Hard delete** (`deleteAgent` + confirm urlKey) remains **Board/Mobile only** for MVP — out of scope for Mastra tools.

---

## Proposed Mastra tools (concrete)

All tools: `tracedAgentFetch` + run token; company scope from `extractToolRuntimeContext`; target agent must belong to same `companyId` (403 otherwise).

### Read

| Tool id | Priority | Input (Zod sketch) | API |
|---------|----------|-------------------|-----|
| `listAgents` | exists | `{}` | `GET /api/companies/{companyId}/agents` |
| `getAgent` | P0 | `{ agentId?: string, urlKey?: string }` (one required) | `GET /api/companies/{companyId}/agents/{agentId}` **(new)** — resolve urlKey server-side or accept either |

### Create

| Tool id | Priority | Notes |
|---------|----------|-------|
| `createAgent` | exists | Note US-CA2 still open for soul/agents/codeExecution fields |

### Update

| Tool id | Priority | Input (Zod sketch) | Lib / API |
|---------|----------|-------------------|-----------|
| `setAgentActive` | **P0** | `{ agentId, status: "active" \| "paused" \| "archived", reason?: string }` | Extend `setAgentActive` or add `setAgentStatus`; `PATCH .../agents/{id}` `{ status }` |
| `setAgentHeartbeat` | **P0** | `{ agentId, enabled, intervalSec?, cronExpression?, scheduleMode?, maxSteps? }` | `updateAgentRuntimeConfig`; mirror MCP `set_heartbeat` |
| `updateAgentProfile` | **P0** | `{ agentId, name?, title?, urlKey?, reportsToId?, instructionsBundleSoulMd?, instructionsBundleAgentsMd?, runtimeType? }` | `updateAgentProfile` + `updateAgentInstructions` + optional `updateAgentCodeExecution` for runtimeType; or single PATCH section |
| `updateAgentModel` | **P1** | `{ agentId, modelId, providerId? }` | `updateAgentModel`; mirror MCP `set_agent_model` |
| `updateAgentCapabilities` | **P1** | `{ agentId, assignedSkills?, assignedToolsets?, assignedTools?, mcpServerIds?, codeExecutionEnabled?, reason: string }` | `updateAgentCapabilities` / `updateAgentCodeExecution`; **escalation policy below** |
| `setAgentOm` | **P2** | `{ agentId, mode: "inherit"\|"off"\|"on", providerId?, modelId?, ... }` | `updateAgentObservationalMemory`; mirror MCP `set_om` |

### Delete

| Approach | MVP |
|----------|-----|
| Soft | `status: "archived"` via `setAgentActive` |
| Hard | **Out of scope** (Board `deleteAgentAction` / mobile `section: delete` only) |

---

## Safety / product rules (MVP)

1. **Company-scoped**: run token `companyId` must match path; target agent `companyId` must match. Cross-company → 403.
2. **No pending_approval mutations** except board fulfillment paths.
3. **Pause other agents**: allowed freely for holders of `agent-management`.
4. **Pause self**: **forbid** direct pause of calling agent (`agentId === runCtx.agentId`) without safeguard — MVP: return `400 self_pause_forbidden` and instruct to use Board or `createApproval({ type: "pause_self", ... })`. *(Open PM decision if confirmation-tool path preferred.)*
5. **Cannot archive last active CEO**: if target is `role=ceo` and `status→archived|paused` would leave zero `active` CEOs in company → 400.
6. **Privilege escalation** (granting `code-execution`, `knowledge-graph`, new MCP servers, or toolsets the caller does not itself hold):
   - **MVP rule:** allow for `agent-management` holders **with required `reason` string** (audit via observability span + optional issue comment). Do **not** require board approval for MVP.
   - **Post-MVP:** optional `createApproval` gate for high-risk grants (computer/sandbox, secrets, MCP).
7. **Hiring** still: board approval + `createAgent` (existing). Management tools do not replace hire.
8. **Durable + UI-visible**: all mutations write the same columns/JSON the Board UI reads.
9. **Observability**: every tool uses `tracedAgentFetch('<toolId>', ...)`.

---

## User Stories

### US-AM1: API surface audit + run-token PATCH gaps — **P0**

**As** a developer  
**I want** company-scoped GET/PATCH routes for a single agent that accept agent run tokens  
**So that** Mastra management tools have a durable HTTP contract (not Board cookies / MCP JWT)

#### Acceptance Criteria

- [ ] **AC-AM1.1**: Inventory documented in this story (Board actions, mobile PATCH sections, MCP tools, lib helpers) — **done in Context above**.
- [ ] **AC-AM1.2**: Add `apps/web/app/api/companies/[companyId]/agents/[agentId]/route.ts`:
  - `GET` — run token; return agent JSON (safe: strip secret values like mobile serializer; return presence flags if needed)
  - `PATCH` — run token; body supports at least: `status`, `heartbeat`, `profile` fields, `modelId`/`providerId`, `capabilities` fields, optional `om`
  - Prefer thin wrappers over existing lib functions (do not fork business logic)
- [ ] **AC-AM1.3**: Auth: missing/invalid token → 401; company mismatch → 403; agent not in company → 404.
- [ ] **AC-AM1.4**: Extend lib if needed: `setAgentStatus(agentId, 'active'|'paused'|'archived')` (or widen `setAgentActive`); enforce pending_approval + last-active-CEO + self-pause rules at route/lib layer.
- [ ] **AC-AM1.5**: urlKey resolution: either path accepts uuid **or** add query `?urlKey=` / alternate route — tools may pass either; document chosen contract.
- [ ] **AC-AM1.6**: No hard-delete on this route in MVP.

#### Quality Gates

| Gate | ACCEPT | HOLD |
|------|--------|------|
| Run-token GET | Valid token returns agent; secrets not leaked | Secrets in JSON / 401 always |
| Run-token PATCH status | Pause/enable persists; UI shows new status | Change ignored or wrong company |
| Cross-company | 403/404 | Mutation succeeds across companies |

#### Out of Scope (US-AM1)

- Exposing Board server actions to agents
- Changing MCP auth model
- Auto-migrating mobile PATCH to run tokens

---

### US-AM2: `getAgent` tool — **P0**

**As** CEO  
**I want** `getAgent` to fetch one teammate by id or urlKey  
**So that** I can inspect status/heartbeat/capabilities before mutating

#### Acceptance Criteria

- [ ] Tool id `getAgent` in `roster` toolset (read path).
- [ ] Schema requires exactly one of `agentId` | `urlKey`.
- [ ] Calls new GET route; returns agent detail suitable for management decisions (status, heartbeat summary, assignedSkills/toolsets/tools, modelId, reportsToId, title).
- [ ] Errors: `{ error, message }` on HTTP failure.

#### Quality Gates

| Gate | ACCEPT | HOLD |
|------|--------|------|
| Binding | Agents with `roster` see `getAgent` at wake | Missing from tools |
| Lookup | urlKey and id both work | Only one works / 500 |

---

### US-AM3: `setAgentActive` / archive — **P0**

**As** CEO  
**I want** to pause, re-enable, or archive teammates  
**So that** I can stop runaway agents and soft-retire seats without Board UI

#### Acceptance Criteria

- [ ] Tool id `setAgentActive` (or `updateAgentStatus`) in **`agent-management`** toolset.
- [ ] Input: `agentId`, `status: active|paused|archived`, optional `reason`.
- [ ] Persists via lib; visible on `/agent/[urlKey]` and roster list.
- [ ] Self-pause forbidden (MVP); last active CEO archive/pause forbidden; pending_approval rejected.
- [ ] Archiving does not hard-delete; agent remains in DB with `status=archived`.

#### Quality Gates

| Gate | ACCEPT | HOLD |
|------|--------|------|
| Pause other | CMO → paused; wakes stop | Still waking |
| Enable | paused → active | Stuck paused |
| Archive | status archived; not deleted | Row deleted / status wrong |
| Self-pause | 400 | CEO deadlocks self |
| Last CEO | 400 when sole active CEO | Company with zero active CEO |

---

### US-AM4: `setAgentHeartbeat` — **P0**

**As** CEO  
**I want** to enable/disable heartbeat and set interval or cron  
**So that** I can schedule Engineer (etc.) without opening Board settings

#### Acceptance Criteria

- [ ] Tool id `setAgentHeartbeat` in `agent-management`.
- [ ] Mirrors MCP `set_heartbeat`: `enabled`, `intervalSec` and/or `cronExpression` (sets scheduleMode accordingly).
- [ ] Uses `updateAgentRuntimeConfig` + timer schedule sync side effects already in lib.
- [ ] Validation errors from `validateHeartbeatSchedule` surface as 400.

#### Quality Gates

| Gate | ACCEPT | HOLD |
|------|--------|------|
| Enable interval | `runtimeConfig.heartbeat.enabled=true` + interval persisted | UI still shows disabled |
| Disable | enabled=false | Timer keeps firing |
| Invalid cron | 400 | Silent accept |

---

### US-AM5: `updateAgentProfile` — **P0**

**As** CEO  
**I want** to update name, title, reportsTo, and instruction bundles  
**So that** org chart and SOUL/AGENTS stay current after hire

#### Acceptance Criteria

- [ ] Tool id `updateAgentProfile` in `agent-management`.
- [ ] Partial updates allowed; at least one field required.
- [ ] Calls `updateAgentProfile` and/or `updateAgentInstructions` (and optionally runtimeType via `updateAgentCodeExecution` if included).
- [ ] Cycle / self-report validation preserved from lib.
- [ ] Changes visible in Board agent settings.

#### Quality Gates

| Gate | ACCEPT | HOLD |
|------|--------|------|
| Title edit | Persists and shows in UI | Unchanged |
| reportsTo | Valid manager OK; cycle rejected | Cycle allowed |
| Soul/agents md | Persist when provided | Cleared unexpectedly |

---

### US-AM6: `updateAgentModel` — **P1**

**As** CEO  
**I want** to change an agent's model/provider  
**So that** I can retarget LLM without Board

#### Acceptance Criteria

- [ ] Tool id `updateAgentModel` in `agent-management`.
- [ ] Input: `agentId`, `modelId`, optional `providerId`.
- [ ] Uses `updateAgentModel`; durable + UI-visible (same as MCP `set_agent_model`).
- [ ] Empty modelId → 400.

#### Quality Gates

| Gate | ACCEPT | HOLD |
|------|--------|------|
| Model change | modelId/providerId updated | UI stale / chat cache wrong (note: lib invalidates chat controller) |

---

### US-AM7: `updateAgentCapabilities` + escalation policy — **P1**

**As** CEO  
**I want** to adjust skills, toolsets, granular tools, and code-execution  
**So that** teammates get the right powers post-hire

#### Acceptance Criteria

- [ ] Tool id `updateAgentCapabilities` in `agent-management`.
- [ ] Supports `assignedSkills`, `assignedToolsets`, `assignedTools`, optional `mcpServerIds`, `codeExecutionEnabled`.
- [ ] **MVP escalation:** require non-empty `reason` when granting privileged capabilities (at minimum: adding `code-execution`, adding MCP servers, or assigning toolsets the caller does not have). Log reason in tool result + observability span.
- [ ] Invalid catalog ids → 400 via existing lib validation.
- [ ] Does not replace hire workflow; does not grant cross-company MCP outside `allowedMcpServerIds`.

#### Quality Gates

| Gate | ACCEPT | HOLD |
|------|--------|------|
| Grant code-execution | Toolset present after update; reason required | Grant without reason / ignored |
| Strip toolset | Removed from assignedToolsets | Still bound at wake |
| Unknown skill | 400 | Silent ignore |

---

### US-AM8: Toolset binding + CEO defaults + skill — **P0** (ships with first mutation tools)

**As** a developer  
**I want** write tools gated by `agent-management`, CEO defaults updated, and a manage-agents skill  
**So that** CTO/PM with roster cannot mutate arbitrary agents by accident

#### Acceptance Criteria

- [ ] **AC-AM8.1**: `ROLE_TOOLS.roster` = `{ listAgents, getAgent, createAgent }`; `ROLE_TOOLS['agent-management']` = mutation tools (not an alias of roster).
- [ ] **AC-AM8.2**: Add `agent-management` to `TOOLSET_CATALOG` / `VALID_TOOLSET_IDS`.
- [ ] **AC-AM8.3**: `ROLE_DEFAULT_TOOLSETS.ceo` includes `agent-management` (in addition to roster).
- [ ] **AC-AM8.4**: CTO/PM defaults **do not** get `agent-management` unless explicitly assigned.
- [ ] **AC-AM8.5**: New skill `packages/skills/manage-agents/SKILL.md` documenting: when to pause vs hire; board approval for hire; self-pause policy; escalation `reason`; prefer archive over delete.
- [ ] **AC-AM8.6**: Add `manage-agents` to `SKILL_CATALOG` and CEO `ROLE_DEFAULT_SKILLS` (keep `create-agent`).
- [ ] **AC-AM8.7**: Existing agents: document one-time note that CEO seats created before this change need Capabilities checkbox **or** a small migration/seed to append `agent-management` + skill for `role=ceo`.

#### Quality Gates

| Gate | ACCEPT | HOLD |
|------|--------|------|
| CEO wake | Has mutation tools | Missing agent-management |
| PM wake | Has list/create/get; **no** setAgentActive | PM can pause |
| Catalog | agent-management visible on Capabilities UI | Orphan toolset id |

---

### US-AM9: Tests + Demo manual — **P0/P1**

**As** Test Lead  
**I want** automated gates and a Demo script  
**So that** we ACCEPT/HOLD confidently

#### Acceptance Criteria

- [ ] Unit tests: tool registration + Zod schemas (`packages/mastra/src/tools/role-tools.test.ts`).
- [ ] Integration tests: GET/PATCH run-token routes (auth, company scope, status, heartbeat).
- [ ] Safety tests: self-pause, last CEO, cross-company.
- [ ] Manual Demo (below) executed; PM sign-off.

#### Manual Demo scenario

**Preconditions:** Local/TEST company with CEO (roster + agent-management), CMO (or any non-CEO), Engineer.

**Steps:**

1. Wake CEO (on-demand).
2. `listAgents` → note CMO + Engineer ids/urlKeys.
3. `getAgent` on CMO → confirm status active.
4. `setAgentActive({ agentId: cmo, status: "paused", reason: "Demo pause" })`.
5. Verify Board `/agent/[cmo]` shows **paused**; CMO does not timer-wake.
6. `setAgentHeartbeat` on Engineer: `enabled: true`, `intervalSec: 3600` (or safe demo interval).
7. Verify Engineer settings show heartbeat enabled + interval.
8. `updateAgentProfile` on Engineer: change `title` (e.g. "Staff Engineer").
9. Verify UI title updated.
10. (P1 if ready) `updateAgentModel` on Engineer; confirm UI model string.
11. Attempt `setAgentActive` pausing **CEO self** → expect error; CEO remains active.
12. Re-enable CMO (`status: "active"`).

**Expected:** All durable; observability spans for each tool; no cross-company leakage; PM ACCEPT.

---

### US-AM10 (optional P2): `setAgentOm`

Mirror MCP `set_om` via `updateAgentObservationalMemory`. Ship only if P0/P1 complete and effort low.

---

## Quality Gates Summary

| Story | Priority | ACCEPT highlights | HOLD highlights |
|-------|----------|-------------------|-----------------|
| US-AM1 | P0 | Run-token GET/PATCH exist; company scoped | Agents still have no mutation HTTP |
| US-AM2 | P0 | getAgent bound on roster | Missing / wrong auth |
| US-AM3 | P0 | Pause/enable/archive + safety | Self-pause works; last CEO archived |
| US-AM4 | P0 | Heartbeat durable + UI | Schedule not synced |
| US-AM5 | P0 | Profile/instructions durable | Cycle allowed |
| US-AM6 | P1 | Model durable | Provider validation broken |
| US-AM7 | P1 | Capabilities + reason on escalate | Silent privilege grants |
| US-AM8 | P0 | CEO has write toolset; PM does not | Alias still shares mutations with roster |
| US-AM9 | P0 | Demo passes | Demo incomplete |
| US-AM10 | P2 | OM mode durable | — |

---

## Out of Scope

1. Hard delete via Mastra tools (Board/Mobile only).
2. Auto-fulfill hire on board approval (separate from createAgent stories).
3. Exposing ops MCP tools inside agent runtime (different auth; keep MCP for humans/ops).
4. Budget mutations, secrets rotation, clone agent as Mastra tools (post-MVP).
5. `wake_agent` as Mastra tool (ops-only; board Wake Now remains).
6. Changing mobile PATCH contract (may later share lib; not required).
7. Multi-company / platform-admin agent management.
8. Completing US-CA2 (tracked in create-agent stories; note dependency for hire-time soul).

---

## Dev implementation notes

### Suggested order

1. **US-AM1** routes + lib status extensions + safety helpers  
2. **US-AM2** getAgent on roster  
3. **US-AM3 + US-AM4 + US-AM5** mutation tools  
4. **US-AM8** split toolsets + CEO defaults + skill (can land with step 3)  
5. **US-AM6 + US-AM7**  
6. **US-AM9** tests + Demo  
7. **US-AM10** if capacity  

### Route sketch

```typescript
// apps/web/app/api/companies/[companyId]/agents/[agentId]/route.ts
// GET  — validateRunToken; assert company; load agent; serialize safe
// PATCH — validateRunToken; assert company; switch on body fields;
//         call setAgentStatus / updateAgentRuntimeConfig / updateAgentProfile / ...
```

Reuse patterns from:

- Collection route auth: `apps/web/app/api/companies/[companyId]/agents/route.ts`
- Section semantics: `apps/web/app/api/mobile/agents/[urlKey]/route.ts` (do **not** require mobile session)
- Lib: `apps/web/lib/agents.ts`

### Tool sketch (`setAgentActive`)

```typescript
const setAgentActiveTool = createTool({
  id: 'setAgentActive',
  description:
    'Set another company agent active, paused, or archived. Cannot pause yourself; cannot archive the last active CEO. Prefer archive over hard delete.',
  inputSchema: z.object({
    agentId: z.string(),
    status: z.enum(['active', 'paused', 'archived']),
    reason: z.string().optional(),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId, agentId: callerId } = extractToolRuntimeContext(requestContext);
    // ... self-check optional client-side; server enforces
    const res = await tracedAgentFetch(
      'setAgentActive',
      requestContext,
      `/api/companies/${companyId}/agents/${inputData.agentId}`,
      { method: 'PATCH', body: JSON.stringify({ status: inputData.status, reason: inputData.reason }) },
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});
```

### Toolset export change

```typescript
const rosterTools = { listAgentsTool, getAgentTool, createAgentTool };
const agentManagementTools = {
  setAgentActiveTool,
  setAgentHeartbeatTool,
  updateAgentProfileTool,
  updateAgentModelTool,
  updateAgentCapabilitiesTool,
  // setAgentOmTool // P2
};

export const ROLE_TOOLS = {
  roster: rosterTools,
  'agent-management': agentManagementTools, // NOT alias of roster
  // ...
};
```

### CEO defaults

```typescript
// packages/shared/src/constants.ts
ceo: ['comments', 'approvals', 'roster', 'agent-management', 'web-search'],
// skills:
ceo: [CONTROL_PLANE_SKILL_SLUG, 'plan-to-tasks', 'create-agent', 'manage-agents', 'para-memory'],
```

### Existing CEO seats

Provide either:

- Migration: `UPDATE agents SET assigned_toolsets = array_append(...) WHERE role = 'ceo' AND NOT ('agent-management' = ANY(...))`, or  
- Release note: Board must tick **Agent management** + **Manage agents** skill once.

---

## Test ACCEPT / HOLD (rollup)

| # | Gate | ACCEPT | HOLD | Verifier |
|---|------|--------|------|----------|
| T1 | API GET run-token | 200 + safe payload | Secrets leaked / 401 | Dev |
| T2 | API PATCH pause | status paused in DB + UI | No change | Test |
| T3 | Tool binding CEO | mutation tools present | Absent | Test |
| T4 | Tool binding PM | no mutation tools | PM can pause | Test |
| T5 | Self-pause | rejected | Succeeds | Test |
| T6 | Last CEO | rejected | Succeeds | Test |
| T7 | Heartbeat | UI + runtimeConfig match | Drift | Test |
| T8 | Profile title | Demo step passes | Title stale | Test + PM |
| T9 | Cross-company | 403/404 | Mutated | Dev |
| T10 | Demo end-to-end | PM sign-off | Incomplete | PM |

---

## Open product decisions (for PM)

1. **Self-pause:** MVP recommends hard forbid + board/approval. Alternative: require `requestConfirmation` / dedicated confirmation tool. Confirm preference.
2. **Escalation:** MVP = required `reason` string + audit span; post-MVP board gate. Confirm OK for granting `code-execution` / MCP without board.
3. **Archive semantics:** Should archived agents disappear from `listAgents` by default (add `includeArchived` flag)? Recommend: list excludes archived unless `includeArchived: true`.
4. **Existing CEO migration:** auto-migrate toolset/skill vs manual Capabilities toggle.
5. **`runtimeType` / harness** on `updateAgentProfile`: include in P0 profile tool or defer to capabilities/code-execution path?
6. **Mobile profile PATCH** currently omits `title` when calling `updateAgentProfile` — fix under Board/mobile hygiene or leave (not blocking agent tools if company PATCH is correct).

---

## Document Maintenance

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-10-01 | PM:Tourbillon / research agent | Initial CRUD stories US-AM1–AM10 from main audit |

---

**End of Document**

---

## Locked PM decisions (2026-10-01)

1. **Self-pause:** hard forbid (`400 self_pause_forbidden`). Board/approval path only for pausing the calling agent.
2. **Capability escalation:** MVP allows grants with required `reason` string (traced); board approval for high-risk grants is post-MVP.
3. **listAgents:** hide `archived` by default; add optional `includeArchived: boolean` (default false).
4. **Existing CEO seats:** include a one-time / deploy note to grant `agent-management` + `manage-agents` skill on Demo CEO (and any existing CEO seats) — do not rely only on ROLE_DEFAULT for new hires.
5. **runtimeType / harness:** deferred from P0 `updateAgentProfile`; optional P1+ field if cheap, else separate ticket.
