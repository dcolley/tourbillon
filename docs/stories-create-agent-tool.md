# Create Agent Tool Stories — TOUR-246

**Document Version**: 1.1  
**Last Updated**: 2026-09-28  
**Status**: Draft — US-CA2 Promoted to REQUIRED (Follow-up to Merged #64/#65)

---

## Overview

This document defines user stories and acceptance criteria for implementing the `createAgent` Mastra tool, enabling agents with the `create-agent` skill (typically CEO) to execute board-approved hires programmatically.

### Problem Statement

**Severity:** P0 / blocking — Demo CFO hire approved twice (approvals d817e537, 468792ba); seat never created. TOUR-238 blocked by TOUR-246.

**Current State:**
1. CEO Capabilities → Skills shows **Create agent** checked (hiring procedure skill at `packages/skills/create-agent/SKILL.md`)
2. Roster toolset exposes **`listAgents`** and **`createAgent`** in `packages/mastra/src/tools/role-tools.ts` (shipped in #65). CEO has both tools available at wake.
3. Backend `POST /api/companies/{companyId}/agents` exists and accepts agent run tokens (`apps/web/app/api/companies/[companyId]/agents/route.ts` → `createAgent` lib at `apps/web/lib/agents.ts`). **Route body type is narrow** (name, title, role, urlKey?, reportsToId?, runtimeType?) — **missing** three optional fields that `createAgent` lib already supports:
   - `instructionsBundleSoulMd?: string` (personality/values) — **not in route type**
   - `instructionsBundleAgentsMd?: string` (team knowledge) — **not in route type**
   - `codeExecutionEnabled?: boolean` (adds/removes `code-execution` toolset) — **not in route type**
4. `createAgent` lib function (`apps/web/lib/agents.ts` L139-L226) **already handles** the three fields via `CreateAgentInput` interface (L120-L131):
   - `normalizeInstructionField(input.instructionsBundleSoulMd)` (L219)
   - `normalizeInstructionField(input.instructionsBundleAgentsMd)` (L220)
   - `codeExecutionEnabled` logic (L187-L192)
5. **Gap**: Route POST body type is narrower than `CreateAgentInput`; `createAgentTool` Zod schema matches narrow route type (shipped in #65). Agents cannot set soul/agents/codeExecution at hire time.
6. Skill `packages/skills/create-agent/SKILL.md` documents `createAgent` tool (shipped in #65).

### Expected Outcome

With the `create-agent` skill assigned and the `roster` (or `agent-management`) toolset enabled, CEO and other authorized agents get a `createAgent` Mastra tool that POSTs a hire payload via run token. The agent can then complete board-approved hires end-to-end without human dashboard intervention.

### Related Links

- **Issue**: TOUR-246 (CEO: Platform Gap: CEO runtime lacks createAgent tool)
- **Blocked Issue**: TOUR-238 (Demo CFO hire)
- **Board Approvals**: d817e537, 468792ba (Demo CFO hire approved twice, never fulfilled)
- **Related Stories**: #62/#63 (Approvals list/read — dedupe before re-filing TOUR-238)

---

## Context

### Current Roster Toolset

From `packages/mastra/src/tools/role-tools.ts` (L71-75):

```typescript
const rosterTools = { listAgentsTool };

export const ROLE_TOOLS: Record<string, Record<string, unknown>> = {
  roster: rosterTools,
  'agent-management': rosterTools, // legacy alias
  // ...
};
```

**Current behavior:**
- Roster toolset is assigned to CEO, CTO, PM by default (`packages/shared/src/constants.ts` L162-167)
- Only provides `listAgents` — used to find agent IDs for assignment

### Tool Assembly at Wake Time

From `packages/mastra/src/agent-factory.ts` L130-180:

```typescript
export async function assembleAgentTools(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions,
): Promise<Record<string, unknown>> {
  const tools: Record<string, unknown> = { ...CONTROL_PLANE_TOOLS };
  // ...
  
  const booleanToolsets = (agentRecord.assignedToolsets ?? []).filter((id) => id !== 'planning');
  for (const toolsetId of booleanToolsets) {
    const roleTools = ROLE_TOOLS[toolsetId];
    if (roleTools) Object.assign(tools, roleTools);
  }
  // ...
}
```

**Binding rule:**
- Tools from `ROLE_TOOLS[toolsetId]` are bound when `assignedToolsets` includes that toolsetId
- CEO has `['comments', 'approvals', 'roster', 'web-search']` by default
- Therefore: CEO already has roster toolset → adding `createAgentTool` to `rosterTools` makes it available to CEO automatically

### Skills and Tool Gating

From `packages/shared/src/constants.ts` L47-54:

```typescript
export const ROLE_DEFAULT_SKILLS: Record<string, string[]> = {
  ceo:      [CONTROL_PLANE_SKILL_SLUG, 'plan-to-tasks', 'create-agent', 'para-memory'],
  cto:      [CONTROL_PLANE_SKILL_SLUG, 'plan-to-tasks', 'para-memory'],
  engineer: [CONTROL_PLANE_SKILL_SLUG, 'para-memory'],
  pm:       [CONTROL_PLANE_SKILL_SLUG, 'plan-to-tasks', 'para-memory'],
  qa:       [CONTROL_PLANE_SKILL_SLUG, 'para-memory'],
  designer: [CONTROL_PLANE_SKILL_SLUG, 'para-memory'],
};
```

**Current CEO defaults:**
- Skills: `control-plane`, `plan-to-tasks`, `create-agent`, `para-memory`
- Toolsets: `comments`, `approvals`, `roster`, `web-search`
- Granular tools: All goal/project/issue tools (read + write)

**Intended gating for `createAgent` tool:**
- **Toolset present**: `roster` or `agent-management` in `assignedToolsets` — CEO already has this
- **Skill assigned** (recommended): `create-agent` in `assignedSkills` — CEO already has this by default

### Hire API Payload

From `apps/web/lib/agents.ts` L120-L131 (CreateAgentInput):

```typescript
export interface CreateAgentInput {
  name: string;
  title: string;
  role: string;
  urlKey?: string;
  companyId?: string;
  reportsToId?: string | null;
  instructionsBundleSoulMd?: string;
  instructionsBundleAgentsMd?: string;
  runtimeType?: AgentRuntimeType;
  codeExecutionEnabled?: boolean;
}
```

**POST endpoint contract** (`apps/web/app/api/companies/[companyId]/agents/route.ts` L32-L66):
- Requires run token authentication in `Authorization: Bearer <token>` header
- Validates `runCtx.companyId === companyId` (403 if mismatch)
- Body fields: `name`, `title`, `role`, `urlKey?`, `reportsToId?`, `runtimeType?`
- Additional fields (`instructionsBundleSoulMd`, `instructionsBundleAgentsMd`, `codeExecutionEnabled`) are handled by `createAgent` lib but **not** in the current route type — **extension needed if agents must set these at hire time**
- Returns 201 + created agent JSON on success
- Returns 400 + `{ error: string }` for validation failures (AgentValidationError)
- Returns 401 if token missing/invalid
- Returns 403 if company mismatch

**What `createAgent` lib does** (L139-L226):
- Slugifies `urlKey` from name if omitted
- Assigns **role defaults** automatically:
  - `assignedSkills` via `buildAssignedSkills(companyId, role)` — merges `ROLE_DEFAULT_SKILLS[role]` + company workspace skills
  - `assignedToolsets` via `ROLE_DEFAULT_TOOLSETS[role]` ± `code-execution` override
  - `runtimeConfig.assignedTools` via `ROLE_DEFAULT_ASSIGNED_TOOLS[role]`
- Seeds per-agent workspace skill templates
- Sets budget to zero, status active
- Returns created agent record

**Implication:** Minimal hire (name, title, role) is sufficient to create a functional agent with role defaults. Skills/toolsets/budget/heartbeat can be edited post-hire via dashboard or dedicated tools if needed.

---

## User Stories

### US-CA1: Add `createAgent` Tool to Roster Toolset

**Status**: ✅ **Shipped in #65**

**As** a developer  
**I want** a `createAgent` Mastra tool added to the roster toolset  
**So that** agents with the roster toolset and create-agent skill can programmatically hire new agents after board approval

#### Acceptance Criteria

- [ ] **AC-CA1.1**: Tool defined in `packages/mastra/src/tools/role-tools.ts`
  - Tool id: `createAgent`
  - Tool description: "Create a new agent record in the company after board approval. Returns the created agent with id, urlKey, and default role settings."
  - Input schema (Zod): matches POST body contract (name, title, role required; urlKey, reportsToId, runtimeType optional)
  - Execute function: calls `tracedAgentFetch` → `POST /api/companies/${companyId}/agents` with run token from `requestContext`
  - Error handling: returns `{ error, message }` on HTTP failure (401, 403, 400, 500)
  - Success: returns parsed JSON response (created agent record)

- [ ] **AC-CA1.2**: Tool added to `rosterTools` object
  ```typescript
  const rosterTools = { 
    listAgentsTool,
    createAgentTool  // <-- new
  };
  ```

- [ ] **AC-CA1.3**: Tool is bound at wake time when roster toolset is assigned
  - Agents with `roster` or `agent-management` in `assignedToolsets` get both `listAgents` and `createAgent`
  - No additional gating required (toolset alone is sufficient; skill is documentation/methodology)

- [ ] **AC-CA1.4**: Tool input validation
  - `name`, `title`, `role` are required strings
  - `role` must be one of: `ceo`, `cto`, `engineer`, `pm`, `qa`, `designer`, `custom`
  - `urlKey` is optional string (slugified on backend if omitted)
  - `reportsToId` is optional string | null (FK to existing agent in same company)
  - `runtimeType` is optional `'agent'` | `'harness'` (defaults to `'agent'`)
  - Other fields (`instructionsBundleSoulMd`, `instructionsBundleAgentsMd`, `codeExecutionEnabled`) are **out of scope** for initial tool — agents create minimal hires and rely on role defaults

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Tool schema** | `createAgentTool` Zod schema matches POST contract | Dev |
| **Tool binding** | CEO agent (has roster toolset) sees `createAgent` in tools at wake | Test Lead |
| **Auth check** | Tool call with valid run token succeeds; invalid token returns 401 | Test Lead |
| **Validation** | Missing name/title/role returns 400; invalid role returns 400 | Test Lead |
| **No regressions** | `listAgents` still works; existing roster functionality unchanged | Test Lead |

#### Implementation Notes

- **Tool location**: `packages/mastra/src/tools/role-tools.ts` (co-located with `listAgentsTool`)
- **API client helper**: Use `extractToolRuntimeContext(requestContext)` to get `companyId`, `agentId` for URL construction
- **Fetch helper**: Use `tracedAgentFetch('createAgent', requestContext, url, options)` for observability
- **Error format**: Match existing tool error pattern: `{ error: string, message: string }`
- **Success format**: Return full agent JSON (id, urlKey, name, title, role, assignedSkills, assignedToolsets, etc.)

#### Out of Scope

- Auto-fulfill hire on board approval without agent action (future enhancement)
- Setting custom skills/toolsets/budget/heartbeat at hire time (use dashboard or dedicated tools post-hire)
- Hire workflow UI for dashboard (separate from agent tool)

---

### US-CA2: Extend createAgent for Optional SOUL.md / AGENTS.md at Hire

**Status**: ⚠️ **REQUIRED** (promoted from optional/skipped MVP)

**As** a developer  
**I want** the POST endpoint and `createAgent` tool to accept optional fields for personality, team knowledge, and code execution  
**So that** agents can set SOUL.md, AGENTS.md, and codeExecutionEnabled at hire time without requiring a second PATCH call

#### Acceptance Criteria

- [ ] **AC-CA2.1**: Route POST body typed as `CreateAgentInput` (or equivalent)
  - `apps/web/app/api/companies/[companyId]/agents/route.ts` body type includes:
    - `instructionsBundleSoulMd?: string` (personality/values markdown)
    - `instructionsBundleAgentsMd?: string` (team knowledge markdown)
    - `codeExecutionEnabled?: boolean` (adds/removes code-execution toolset)
  - Route passes body directly to `createAgent(body)` (lib already handles these fields)

- [ ] **AC-CA2.2**: `createAgentTool` Zod schema widens to match route
  - Tool `packages/mastra/src/tools/role-tools.ts` adds three optional fields to input schema
  - Tool POSTs full `JSON.stringify(inputData)` (no field filtering)

- [ ] **AC-CA2.3**: Minimal hire still succeeds (backward compatible)
  - POST `{ name, title, role }` alone returns 201 + agent JSON
  - Omitted `instructionsBundleSoulMd` / `instructionsBundleAgentsMd` remain `null` in DB
  - Omitted `codeExecutionEnabled` applies role defaults

- [ ] **AC-CA2.4**: POST with soul/agents md persists and returns
  - POST `{ name, title, role, instructionsBundleSoulMd: "# Soul\nBe kind." }` returns 201
  - GET the created agent confirms `instructionsBundleSoulMd` is persisted (not null)
  - Strings are normalized via `normalizeInstructionField` (trim, null if empty)

- [ ] **AC-CA2.5**: POST with `codeExecutionEnabled` overrides role defaults
  - POST `{ name, title, role: "engineer", codeExecutionEnabled: false }` omits `code-execution` toolset
  - POST `{ name, title, role: "custom", codeExecutionEnabled: true }` adds `code-execution` toolset

- [ ] **AC-CA2.6**: Validation errors are clear
  - Invalid `role` still returns 400 (baseline behavior preserved)
  - Non-string soul/agents or non-boolean codeExecution handled gracefully (400 or ignored)

- [ ] **AC-CA2.7**: SKILL.md Tool Usage (soft / optional)
  - `packages/skills/create-agent/SKILL.md` § Tool Usage mentions the three optional fields
  - Example snippet shows soul/agents/codeExecution usage

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Route widens** | POST body typed as `CreateAgentInput` or includes three optional fields | Dev |
| **Tool widens** | `createAgentTool` Zod includes three optional fields | Dev |
| **Minimal hire** | POST with only name/title/role still succeeds (backward compat) | Test Lead |
| **Soul/agents persist** | POST with instructionsBundleSoulMd sets agent personality | Test Lead |
| **codeExecution override** | POST with `codeExecutionEnabled: false` omits code-execution toolset | Test Lead |
| **Validation preserved** | Invalid role still returns 400; type errors handled gracefully | Test Lead |

#### Implementation Notes

**Decision:** This story is **REQUIRED** as a follow-up to #65. While minimal hire (name, title, role) is sufficient for baseline agent creation, agents need to set custom SOUL.md, AGENTS.md, and code execution preferences at hire time for complete onboarding scenarios.

**Changes required:**
1. **Route type widen** (`apps/web/app/api/companies/[companyId]/agents/route.ts`):
   ```typescript
   import { CreateAgentInput, createAgent, AgentValidationError } from '@/lib/agents';
   
   const body = await req.json() as CreateAgentInput;
   ```
   Pass `body` directly to `createAgent(body)` (lib already supports these fields)

2. **Tool schema widen** (`packages/mastra/src/tools/role-tools.ts`):
   ```typescript
   inputSchema: z.object({
     name: z.string(),
     title: z.string(),
     role: z.string(),
     urlKey: z.string().optional(),
     reportsToId: z.string().optional(),
     runtimeType: z.enum(['agent', 'harness']).optional(),
     instructionsBundleSoulMd: z.string().optional(),
     instructionsBundleAgentsMd: z.string().optional(),
     codeExecutionEnabled: z.boolean().optional(),
   }),
   ```
   Execute function: `JSON.stringify(inputData)` already POSTs full payload

3. **SKILL.md update** (optional):
   - Add § Tool Usage note for the three optional fields
   - Example:
     ```markdown
     Optional at hire:
     - `instructionsBundleSoulMd`: Agent personality/values (SOUL.md content)
     - `instructionsBundleAgentsMd`: Agent team knowledge (AGENTS.md content)
     - `codeExecutionEnabled`: Boolean to override role's default code-execution toolset
     ```

**Foundation:** `createAgent` lib function (L187-L192, L219-L220) already handles these fields. Only route type and tool schema need widening.

#### Out of Scope

- Setting `assignedSkills`, `assignedToolsets`, `mcpServerIds`, `budgetMonthlyTokens` arrays directly at hire (complex validation; prefer role defaults + post-hire edits)
- Budget enforcement or approval gates beyond board approval
- Org chart validation beyond `reportsToId` FK check
- Dashboard hire form rewrite (separate UI work)

---

### US-CA3: Update `create-agent` Skill Documentation

**Status**: ✅ **Shipped in #65** (baseline); AC-CA3.2 Tool Usage will mention US-CA2 fields when implemented

**As** a developer  
**I want** the `create-agent` skill to name the `createAgent` tool explicitly  
**So that** agents know which tool to call after board approval

#### Acceptance Criteria

- [ ] **AC-CA3.1**: Update `packages/skills/create-agent/SKILL.md` § Agent Creation Checklist (L20-L32)
  - Replace vague "Before calling the agents API" with "Before calling `createAgent`"
  - Add checklist item: "✓ Tool call: `createAgent({ name, title, role, reportsToId?, runtimeType? })`"

- [ ] **AC-CA3.2**: Add § Tool Usage section after § Agent Creation Checklist
  ```markdown
  ## § Tool Usage

  Call `createAgent` with the following parameters:

  - `name` (required): Agent display name (e.g., "Sarah Chen")
  - `title` (required): Job title (e.g., "Chief Financial Officer")
  - `role` (required): One of: `ceo`, `cto`, `engineer`, `pm`, `qa`, `designer`, `custom`
  - `urlKey` (optional): Short slug for URLs (e.g., "cfo"). Auto-slugified from name if omitted.
  - `reportsToId` (optional): Agent ID this hire reports to in the org chart
  - `runtimeType` (optional): `"agent"` (default) or `"harness"` (multi-heartbeat coding)

  **Role defaults:**
  - Skills, toolsets, and granular tools are assigned automatically based on role
  - Default model uses company LLM provider registry
  - Budget defaults to zero (unlimited); set via dashboard after hire
  - Heartbeat disabled by default; enable via dashboard after hire

  **Example:**
  ```
  createAgent({
    name: "Sarah Chen",
    title: "Chief Financial Officer",
    role: "custom",
    reportsToId: "<ceo-agent-id>",
    runtimeType: "agent"
  })
  ```

  The tool returns the created agent record with `id`, `urlKey`, and assigned defaults.
  ```

- [ ] **AC-CA3.3**: Update § Post-Creation Steps (L65-L75)
  - Change "After the agent record is created:" to "After calling `createAgent`:"
  - Add step 0: "Verify tool call succeeded (no error in response)"
  - Renumber existing steps 1-5 to 1-6

- [ ] **AC-CA3.4**: Add § Dedupe Check section before § Tool Usage
  ```markdown
  ## § Dedupe Check (When listApprovals Available)

  If `listApprovals` tool is available (story #62/#63):
  - Before creating agent, call `listApprovals({ type: "hire_agent", status: "approved" })`
  - Check if an approval for this hire already exists and was fulfilled
  - If agent already created, skip `createAgent` and comment on linked issue with existing agent ID

  If `listApprovals` is not available:
  - Skip dedupe check (acceptable risk of duplicate hires if approval re-runs)
  - Future: implement dedupe via board approval decision tracking
  ```

- [ ] **AC-CA3.5**: No changes to § Skill Assignment by Role or § Tool Tier Assignment by Role
  - Those sections are reference material; keep as-is

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Tool named** | Skill mentions `createAgent` explicitly, not vague "API" | Test Lead |
| **Checklist complete** | Agent Creation Checklist includes `createAgent` call | Test Lead |
| **Examples clear** | Tool Usage examples match Zod schema | Dev |
| **Dedupe guidance** | Skill documents listApprovals dedupe when available | Test Lead |

#### Implementation Notes

- **Skill file location**: `packages/skills/create-agent/SKILL.md`
- **When to edit**: After `createAgentTool` is implemented (US-CA1) so skill references match reality
- **Dedupe story dependency**: #62/#63 (Approvals list/read) is **complementary, not required**. The skill should document dedupe as optional when listApprovals is available, not block on it.

#### Out of Scope

- Changing role defaults tables (those are reference docs, not instructions)
- Adding validation logic to the skill (validation belongs in tool/API)
- Workspace skills seeding documentation (already covered in § Post-Creation Steps)

---

### US-CA4: Integration Testing and Manual Demo CFO Hire

**Status**: ✅ **AC-CA4.1 shipped in #65** (unit tests); AC-CA4.2/CA4.3/CA4.4 ongoing

**As** a test lead  
**I want** integration tests and a manual demo CFO hire scenario  
**So that** we verify the end-to-end workflow from board approval to agent roster

#### Acceptance Criteria

- [ ] **AC-CA4.1**: Unit test for `createAgentTool` (Jest or Vitest)
  - Test location: `packages/mastra/src/tools/role-tools.test.ts` (new file or add to existing)
  - Test cases:
    1. Tool is defined and exported in `rosterTools`
    2. Tool schema validates required fields (name, title, role)
    3. Tool schema accepts optional fields (urlKey, reportsToId, runtimeType)
    4. Tool schema rejects invalid role values

- [ ] **AC-CA4.2**: Integration test for POST endpoint with run token
  - Test location: `apps/web/app/api/companies/[companyId]/agents/route.test.ts` (new file or add to existing)
  - Test cases:
    1. POST with valid run token and minimal body returns 201 + agent JSON
    2. POST with missing name/title/role returns 400
    3. POST with invalid role returns 400
    4. POST with invalid run token returns 401
    5. POST with mismatched companyId returns 403
    6. POST with duplicate urlKey returns 400

- [ ] **AC-CA4.3**: Manual Demo CFO hire scenario
  - **Preconditions:**
    1. CEO agent has roster toolset and create-agent skill assigned (already true by default)
    2. Demo CFO hire board approval exists and is approved (approvals d817e537 or 468792ba, or create new)
    3. Linked issue (TOUR-238 or test issue) is in `blocked` status with `boardApprovalId` set
  - **Steps:**
    1. Trigger CEO heartbeat wake (assignment, on-demand, or timer)
    2. CEO sees approval resolved (or reads issue comment + approval status)
    3. CEO calls `createAgent({ name: "Demo CFO", title: "Chief Financial Officer", role: "custom" })`
    4. Tool returns 201 + created agent JSON with id, urlKey
    5. CEO posts comment on linked issue: "Agent created: [urlKey] (id: [agentId])"
    6. CEO updates linked issue status to `done`
  - **Expected result:**
    - New agent appears in company roster at `/dashboard/agents`
    - Agent has role defaults (skills: control-plane + para-memory; toolsets: comments; granular tools: read-only goal/project + issue write)
    - Agent urlKey is accessible at `/dashboard/agents/[urlKey]`
    - Linked issue status is `done` with CEO comment
  - **Verifier:** Test Lead observes Demo CFO hire execution; PM signs off on acceptance

- [ ] **AC-CA4.4**: Observability verification
  - When `OBSERVABILITY_ENABLED=true`, tool call span appears in Postgres `agent_observability_events`
  - Span includes `createAgent` tool name and agent_id context
  - Span payload includes input (name, title, role) but **not** sensitive fields if added later (e.g., API keys)

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Unit tests pass** | Tool schema and registration tests pass | Dev |
| **Integration tests pass** | POST endpoint auth and validation tests pass | Dev |
| **Manual demo succeeds** | CEO creates Demo CFO agent end-to-end | Test Lead + PM |
| **Roster updated** | New agent visible on dashboard | Test Lead |
| **No leakage** | Observability spans do not expose sensitive data | Test Lead |

#### Implementation Notes

- **Test framework:** Vitest preferred for new tests (aligns with Mastra ecosystem)
- **Mocking strategy:** Mock `tracedAgentFetch` in tool unit tests; use test database in integration tests
- **Test environment:** Local dev setup (Postgres + Redis + web + workers) sufficient for manual demo
- **Observability check:** Run with `OBSERVABILITY_ENABLED=true` to verify span export; check Postgres directly or use `/observability` UI

#### Out of Scope

- Automated regression tests for all agent hire permutations (cover basics; expand later)
- CI/CD integration for tool tests (future work)
- Load testing or concurrent hire scenarios

---

## Quality Gates Summary

| Story | Gate | ACCEPT Condition | HOLD Condition |
|-------|------|------------------|----------------|
| **US-CA1** | Tool binding | CEO has `createAgent` at wake | Tool not in agent tools |
| **US-CA1** | Auth check | Valid token succeeds; invalid fails 401 | Auth bypass or always 401 |
| **US-CA1** | Validation | Missing fields → 400; invalid role → 400 | Validation errors silent or wrong |
| **US-CA2** | Route widens | POST body typed as `CreateAgentInput` or includes three optional fields | Type still narrow |
| **US-CA2** | Tool widens | `createAgentTool` Zod includes three optional fields | Schema missing fields |
| **US-CA2** | Minimal hire | POST with name/title/role succeeds (backward compat) | Minimal hire now fails |
| **US-CA2** | Soul/agents persist | POST with instructionsBundleSoulMd persists and returns | Fields ignored/cleared |
| **US-CA2** | codeExecution override | POST with `codeExecutionEnabled: false` omits code-execution toolset | Override broken |
| **US-CA2** | Validation preserved | Invalid role still 400; type errors handled gracefully | Validation broken or crashes |
| **US-CA3** | Tool named | Skill says `createAgent`, not "API" | Vague or missing tool reference |
| **US-CA3** | Dedupe guidance | Skill documents listApprovals check | Dedupe logic missing or wrong |
| **US-CA4** | Unit tests | Tool schema tests pass | Tool not tested or tests fail |
| **US-CA4** | Integration tests | POST endpoint tests pass | Auth or validation broken |
| **US-CA4** | Manual demo | CEO creates Demo CFO end-to-end | Hire workflow incomplete |
| **US-CA4** | Roster check | New agent visible on dashboard | Agent created but not in roster |

---

## Out of Scope

The following are explicitly **not** in scope for TOUR-246 or this documentation PR:

1. **Auto-fulfill hire on board approval** without agent action
   - Board approval decision → automatic agent creation without CEO wake
   - Future enhancement after approval tracking is mature

2. **Approvals list/read tools** (#62/#63)
   - Complementary dedupe mechanism, **not required** to unblock Demo CFO hire
   - CEO can create agent after board approval without checking duplicates (acceptable risk for P0 unblock)

3. **Custom skills/toolsets/budget at hire time**
   - POST with `assignedSkills`, `assignedToolsets`, `budgetMonthlyTokens` arrays
   - Prefer role defaults + post-hire dashboard edits for MVP

4. **Hire workflow UI** for dashboard
   - Human-initiated hire via form at `/dashboard/agents/new`
   - Separate from agent tool (already exists at dashboard create form)

5. **Org chart cycle detection beyond `reportsToId` FK**
   - `createAgent` lib validates `reportsToId` FK exists
   - Circular reporting chains (A→B→C→A) are validated on profile update, not hire

6. **Multi-tenancy or cross-company hires**
   - Agents can only hire within their own company (enforced by run token)

7. **Mobile-only hire UI or API endpoints**
   - `POST /api/mobile/agents` is out of scope; focus on `/api/companies/[companyId]/agents`

8. **Replacing human dashboard hire form**
   - Agent tool complements dashboard, does not replace it

---

## Implementation Notes for Dev

### Tool Registration

1. **File:** `packages/mastra/src/tools/role-tools.ts`
2. **Pattern:** Follow `listAgentsTool` structure (L56-L69)
3. **Schema:**
   ```typescript
   const createAgentTool = createTool({
     id: 'createAgent',
     description: 'Create a new agent record in the company after board approval. Returns the created agent with id, urlKey, and default role settings.',
     inputSchema: z.object({
       name: z.string().describe('Agent display name (e.g., "Sarah Chen")'),
       title: z.string().describe('Job title (e.g., "Chief Financial Officer")'),
       role: z.enum(['ceo', 'cto', 'engineer', 'pm', 'qa', 'designer', 'custom']).describe('Agent role'),
       urlKey: z.string().optional().describe('Short slug for URLs (e.g., "cfo"). Auto-slugified from name if omitted.'),
       reportsToId: z.string().nullable().optional().describe('Agent ID this hire reports to in the org chart'),
       runtimeType: z.enum(['agent', 'harness']).optional().describe('Runtime type: agent (default) or harness (multi-heartbeat coding)'),
     }),
     execute: async (inputData, { requestContext }) => {
       const { companyId } = extractToolRuntimeContext(requestContext);
       if (!companyId) {
         return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
       }
       const res = await tracedAgentFetch('createAgent', requestContext, `/api/companies/${companyId}/agents`, {
         method: 'POST',
         body: JSON.stringify(inputData),
       });
       if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
       return res.json();
     },
   });
   ```
4. **Export:** Add to `rosterTools` object (L71)
   ```typescript
   const rosterTools = { 
     listAgentsTool,
     createAgentTool  // <-- new
   };
   ```

### API Route (Optional Extension — US-CA2)

If implementing US-CA2 (extended POST body):

1. **File:** `apps/web/app/api/companies/[companyId]/agents/route.ts`
2. **Change:** Update body type on L45-L52 from inline type to `CreateAgentInput`
   ```typescript
   import { AgentValidationError, createAgent, type CreateAgentInput } from '@/lib/agents';
   
   // ...
   
   const body = await req.json() as CreateAgentInput;
   ```
3. **Validation:** `createAgent` lib already handles all `CreateAgentInput` fields; no logic changes needed

### Skill Update

1. **File:** `packages/skills/create-agent/SKILL.md`
2. **Changes:**
   - L22: Replace "Before calling the agents API" → "Before calling `createAgent`"
   - Add new § Tool Usage section after L32
   - Add new § Dedupe Check section before Tool Usage
   - Update § Post-Creation Steps (L65-L75) to reference tool call

### Testing

1. **Unit tests:**
   - File: `packages/mastra/src/tools/role-tools.test.ts` (create if missing)
   - Test tool schema, export, validation
2. **Integration tests:**
   - File: `apps/web/app/api/companies/[companyId]/agents/route.test.ts` (create if missing)
   - Test POST endpoint with run token, validation, auth
3. **Manual demo:**
   - Use existing CEO agent on local dev or TEST environment
   - Trigger wake, call `createAgent`, verify roster updated

---

## Manual Test Scenario: Demo CFO Hire

### Preconditions

1. **Environment:** Local dev (Postgres + Redis + web on :3002 + workers on :3003) or TEST
2. **CEO agent:**
   - Exists in company roster
   - Has `roster` toolset (default for CEO role)
   - Has `create-agent` skill (default for CEO role)
3. **Board approval:**
   - Create test approval: `createApproval({ type: "hire_agent", payload: { title: "Demo CFO Hire", summary: "Hire CFO for financial planning", recommendedAction: "Approve" }, issueIds: ["<test-issue-id>"] })`
   - Approve via `/approval` UI or direct DB update: `UPDATE approvals SET status = 'approved', decidedAt = NOW() WHERE id = '<approval-id>'`
4. **Linked issue:**
   - Status `blocked`, `boardApprovalId` set to approval ID
   - Assigned to CEO

### Steps

1. **Trigger CEO wake:**
   - Option A: Approval wake (after decide) → `POST /internal/wake` with `reason: approval_resolved`
   - Option B: On-demand wake → Click "Wake Now" on CEO agent page
   - Option C: Assignment wake → Assign issue to CEO

2. **CEO reads context:**
   - `getHeartbeatContext` returns linked issue + recent comments
   - CEO sees approval resolved (either via linked approval in context or by reading issue body)

3. **CEO calls `createAgent`:**
   ```json
   {
     "name": "Sarah Chen",
     "title": "Chief Financial Officer",
     "role": "custom",
     "reportsToId": "<ceo-agent-id>"
   }
   ```

4. **Tool returns success:**
   ```json
   {
     "id": "agent_xyz123",
     "urlKey": "sarah-chen",
     "name": "Sarah Chen",
     "title": "Chief Financial Officer",
     "role": "custom",
     "status": "active",
     "assignedSkills": ["control-plane", "para-memory"],
     "assignedToolsets": ["comments"],
     "runtimeConfig": { "assignedTools": [] },
     // ... other fields
   }
   ```

5. **CEO posts comment:**
   ```markdown
   Agent created: `sarah-chen` (id: `agent_xyz123`)

   Role defaults applied:
   - Skills: control-plane, para-memory
   - Toolsets: comments
   - Granular tools: read-only goal/project + issue write

   Next steps:
   1. Set budget via dashboard: `/dashboard/agents/sarah-chen`
   2. Configure heartbeat schedule if needed
   3. Assign onboarding issue to new agent
   ```

6. **CEO updates issue:**
   ```json
   {
     "status": "done",
     "comment": "<comment-from-step-5>"
   }
   ```

### Expected Results

- [ ] New agent appears in roster: `http://localhost:3002/dashboard/agents`
- [ ] Agent detail page accessible: `http://localhost:3002/dashboard/agents/sarah-chen`
- [ ] Agent record shows:
  - Status: `active`
  - Skills: `control-plane`, `para-memory` (custom role defaults)
  - Toolsets: `comments` (custom role default)
  - Granular tools: empty or read-only defaults (custom role)
  - Budget: 0 (unlimited)
  - Heartbeat: disabled
- [ ] Linked issue status: `done`
- [ ] Issue comment thread includes CEO's creation comment
- [ ] No errors in web or workers logs

### Failure Scenarios

| Scenario | Expected Error | Recovery |
|----------|----------------|----------|
| Missing name | 400: "Name is required." | CEO retries with valid name |
| Invalid role | 400: "A valid role is required." | CEO retries with valid role (ceo/cto/engineer/pm/qa/designer/custom) |
| Duplicate urlKey | 400: "Agent ID \"sarah-chen\" is already in use." | CEO retries with different urlKey or name |
| Invalid reportsToId | 400: "Reports-to agent not found in this company." | CEO retries with valid agent ID or omits reportsToId |
| Run token expired | 401: "Unauthorized" | Wake runner regenerates token on next heartbeat |

---

## Acceptance Checklist

Before marking TOUR-246 as **done**, verify:

- [x] **US-CA1 complete** (✅ shipped in #65):
  - [x] `createAgentTool` defined in `role-tools.ts`
  - [x] Tool added to `rosterTools` export
  - [x] CEO agent sees tool at wake (check agent tools in observability or logs)
  - [x] Tool call with valid token succeeds (manual test or integration test)
  - [x] Tool call validation errors return 400 (manual test or integration test)

- [ ] **US-CA2 complete** (⚠️ REQUIRED — follow-up to #65):
  - [ ] POST route type widens to `CreateAgentInput` (or includes three optional fields)
  - [ ] `createAgentTool` Zod schema includes `instructionsBundleSoulMd`, `instructionsBundleAgentsMd`, `codeExecutionEnabled`
  - [ ] Optional fields work (soul/agents persists, codeExecution overrides role defaults)
  - [ ] Minimal hire (name/title/role only) still succeeds (backward compatible)
  - [ ] Invalid role still returns 400; type errors handled gracefully

- [x] **US-CA3 complete** (✅ baseline shipped in #65; AC-CA3.2 Tool Usage will mention US-CA2 fields):
  - [x] Skill mentions `createAgent` tool explicitly
  - [x] Tool Usage section added with examples
  - [x] Dedupe Check section added (listApprovals guidance)
  - [x] Post-Creation Steps updated

- [ ] **US-CA4 complete** (⚠️ AC-CA4.1 shipped in #65; integration/manual tests ongoing):
  - [x] Unit tests for tool schema pass
  - [ ] Integration tests for POST endpoint pass
  - [ ] Manual Demo CFO hire scenario executed and passed
  - [ ] New agent visible on roster
  - [ ] Issue status updated to done
  - [ ] No errors or regressions

- [x] **Documentation updated**:
  - [x] This story linked from `docs/README.md`
  - [x] AGENTS.md unchanged (tool addition does not require AGENTS.md update)

- [ ] **Deployment ready**:
  - [ ] Local dev smoke test passed
  - [ ] TEST environment ready (if applicable)
  - [ ] No breaking changes to existing hire workflows (dashboard form still works)

---

## References

- **AGENTS.md**: Tourbillon agent architecture, tool tiers, skill system
- **Issue TOUR-246**: CEO: Platform Gap: CEO runtime lacks createAgent tool
- **Issue TOUR-238**: Demo CFO hire (blocked by TOUR-246)
- **Approvals**: d817e537, 468792ba (Demo CFO hire approved twice, never fulfilled)
- **Related Stories**: #62/#63 (Approvals list/read — dedupe before re-filing TOUR-238)
- **Skill**: `packages/skills/create-agent/SKILL.md`
- **API**: `apps/web/app/api/companies/[companyId]/agents/route.ts`
- **Lib**: `apps/web/lib/agents.ts` (`createAgent` function L139-L226)
- **Defaults**: `packages/shared/src/constants.ts` (role defaults, skill catalog, toolset catalog)

---

## Document Maintenance

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-09-28 | Docs PR #64 (TOUR-246) | Initial draft with US-CA1–CA4 stories |
| 1.1 | 2026-09-28 | Docs PR #66 (TOUR-246 follow-up) | Promote US-CA2 from optional to REQUIRED; mark US-CA1/CA3/CA4.1 shipped in #65; update gates/checklist |

---

**End of Document**
