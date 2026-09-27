# User Stories: Agent Approvals List/Read Tools (Prevent Re-file)

## Overview

This document describes the user stories and acceptance criteria for adding **list** and **read** approval tools to the agent-facing `approvals` toolset. This is a **P0 bugfix** — agents currently cannot see past board decisions, leading to duplicate approval requests that block workflow progress.

## Context

**Problem**: The CEO agent re-filed "Hire Dedicated CFO" approval (d817e537) after the board already approved it. The hired agent seat never appeared because the CEO lacked visibility into the prior decision.

**Root Cause**: Agent `approvals` toolset (`packages/mastra/src/tools/role-tools.ts`) is **create-only**:
- ✅ Agents can call `createApproval` → POST `/api/companies/{companyId}/approvals`
- ❌ Agents **cannot** list or read past approvals
- ✅ Board/mobile UI **can** read approvals via GET `/api/mobile/approvals` (uses `listCompanyApprovals` helper)
- ❌ Company route GET `/api/companies/{companyId}/approvals` is currently **POST-only** (returns 405)

**Impact**: Duplicate approval requests for hires, large spends, and irreversible actions. Agents re-submit identical requests instead of checking if an equivalent approved or pending approval already exists.

**Related Systems**:
- **Mobile/Board UI**: Already has read access via `/api/mobile/approvals` (company JWT auth)
- **MCP Server**: Already has `list_approvals` tool (company session)
- **Agent toolset**: Missing list/read tools (agent run-token auth)

---

## User Stories

### US-AL1: List Approvals Tool

**As a** Tourbillon agent with the `approvals` toolset,

**I want to** list past and current board approvals with filtering by status (pending, approved, rejected, all),

**So that** I can check whether an equivalent approval already exists before filing a duplicate request.

---

#### Acceptance Criteria: US-AL1

- [ ] **AC-AL1.1: Tool Registration**  
  The `approvals` toolset exports a `listApprovalsTool` registered alongside `createApprovalTool` in `packages/mastra/src/tools/role-tools.ts`.

- [ ] **AC-AL1.2: Input Schema**  
  The tool accepts:
  - `status` (optional): `"pending" | "approved" | "rejected" | "all"` (default: `"all"`)
  - `limit` (optional): integer, max results (default: `50`, range: `1–100`)
  - `search` (optional): string, filters by approval `type` or `payload.title` (case-insensitive substring match)

- [ ] **AC-AL1.3: API Route (List)**  
  A new GET handler on `/api/companies/{companyId}/approvals` route:
  - Authenticates via agent run token (same `validateRunToken` as POST)
  - Calls `listCompanyApprovals(companyId)` helper (or equivalent query logic reused from `/api/mobile/approvals`)
  - Filters results by `status` query param (if not `"all"`)
  - Applies `limit` and optional `search` filter
  - Returns JSON: `{ approvals: [...] }`

- [ ] **AC-AL1.4: Response Format**  
  Each approval object includes:
  - `id`, `type`, `status`, `createdAt`, `decidedAt`, `payload` (with `title`, `summary`)
  - `requester` — `{ id, name, urlKey }` of the requesting agent (null if agent deleted)
  - `linkedIssues` — array of `{ id, identifier, title, status, boardApprovalId }` (same as mobile API)
  - Optional: `hitlyApprovalId`, `hitlyError` (if HITLy gate is enabled)

- [ ] **AC-AL1.5: Auth & Permissions**  
  - Agent run token is required (same as `createApproval`)
  - No company JWT required (agents authenticate via run token, not human session)
  - Agent can only list approvals for their own company (enforced by `companyId` in token)

- [ ] **AC-AL1.6: Tool Output**  
  The tool returns the full list of approvals matching the filter, or an error if the API call fails (same pattern as `listAgentsTool`).

---

### US-AL2: Get Approval Tool

**As a** Tourbillon agent with the `approvals` toolset,

**I want to** read the full details of a single approval by its ID,

**So that** I can inspect the decision, payload, and linked issues before deciding whether to re-file or reference the existing approval.

---

#### Acceptance Criteria: US-AL2

- [ ] **AC-AL2.1: Tool Registration**  
  The `approvals` toolset exports a `getApprovalTool` registered alongside `createApprovalTool` and `listApprovalsTool` in `packages/mastra/src/tools/role-tools.ts`.

- [ ] **AC-AL2.2: Input Schema**  
  The tool accepts:
  - `approvalId` (required): string, the approval ID to fetch

- [ ] **AC-AL2.3: API Route (Get)**  
  A new GET handler on `/api/companies/{companyId}/approvals/{approvalId}` route:
  - Authenticates via agent run token (same `validateRunToken` as POST)
  - Calls `listCompanyApprovals(companyId)` and finds the matching approval by ID (same pattern as mobile `/api/mobile/approvals/[id]`)
  - Returns 404 if approval not found or belongs to a different company
  - Returns JSON: `{ approval: {...} }` (same format as list)

- [ ] **AC-AL2.4: Response Format**  
  The approval object includes all fields from `listApprovals` (see AC-AL1.4), plus any additional detail fields stored in `payload`:
  - `recommendedAction`, `risks` (if present)
  - Full `priorStatuses` map (issue IDs → prior status before halt)
  - `note` (if decided — human decision comment)

- [ ] **AC-AL2.5: Auth & Permissions**  
  - Agent run token is required (same as `createApproval`)
  - Agent can only fetch approvals for their own company (enforced by `companyId` in token)
  - Returns 404 if the approval belongs to another company (not 403 — don't leak existence)

- [ ] **AC-AL2.6: Tool Output**  
  The tool returns the approval object, or an error if not found or if the API call fails.

---

### US-AL3: Dedupe Protocol & Documentation

**As a** Tourbillon PM/operator,

**I want** agent prompts and control-plane documentation to **require** checking past approvals before creating a new one,

**So that** agents follow a "search before you file" discipline and avoid duplicate approvals.

---

#### Acceptance Criteria: US-AL3

- [ ] **AC-AL3.1: Control-Plane Skill Update**  
  The `control-plane` SKILL.md (`packages/skills/control-plane/SKILL.md`) is updated to document the new tools in the "Board Governance" section (or similar):
  - `listApprovals` — list past/pending approvals by status
  - `getApproval` — fetch full approval detail by ID
  - **Protocol**: Before calling `createApproval` for hire/spend, the agent **must** call `listApprovals(status: "all", limit: 50)` and check if an equivalent approval exists.

- [ ] **AC-AL3.2: Equivalence Heuristic (Documented)**  
  The documentation defines "equivalent approval" for dedupe purposes:
  - Same `type` (e.g., `"hire_agent"`)
  - Similar `payload.title` or `payload.summary` (fuzzy match: same key terms, same role/amount/action)
  - Status is `"approved"` (within last 30 days) or `"pending"` (any age)
  - **Skip re-file** if equivalent approved or pending approval exists
  - **OK to file** if no equivalent exists, or if all prior requests were `"rejected"`

- [ ] **AC-AL3.3: Tool Description Update**  
  The `createApprovalTool` description string is updated to reference the new dedupe protocol:
  - Add: "Before filing, call `listApprovals` to check for an equivalent approved or pending request. Do not re-file if an equivalent exists."

- [ ] **AC-AL3.4: Examples in Docs**  
  The control-plane or approval-specific documentation includes an example:
  - **Scenario**: Agent wants to hire a CFO
  - **Step 1**: Call `listApprovals(status: "all", limit: 50, search: "CFO")`
  - **Step 2**: If `type: "hire_agent"`, `payload.title` contains "CFO", and `status: "approved"` (recent) or `"pending"` → **skip re-file**, comment on linked issue referencing approval ID
  - **Step 3**: If no match → proceed with `createApproval`

---

### US-AL4: Quality Gates & Testing

**As a** Tourbillon Dev/QA,

**I want** clear acceptance gates and test scenarios for the new approval tools,

**So that** the feature can be validated on TEST before deploying to production.

---

#### Acceptance Criteria: US-AL4

- [ ] **AC-AL4.1: Manual Test Plan**  
  A test scenario is documented (in this story doc or in TEST checklist):
  1. **Setup**: TEST Demo company, CEO agent with `approvals` toolset enabled
  2. **Precondition**: Board has approved "Hire Dedicated CFO" (approval ID `d817e537` or equivalent)
  3. **Test 1 (List)**: CEO calls `listApprovals(status: "all")` → returns the approved CFO approval
  4. **Test 2 (Get)**: CEO calls `getApproval(approvalId: "d817e537")` → returns full approval with `status: "approved"`, requester, linkedIssues
  5. **Test 3 (Dedupe)**: CEO evaluates a new "Hire CFO" goal → calls `listApprovals` first → finds approved request → skips re-file → comments on issue referencing approval ID
  6. **Test 4 (New Request)**: CEO evaluates "Hire CMO" goal → calls `listApprovals(search: "CMO")` → no match → proceeds with `createApproval`

- [ ] **AC-AL4.2: Auth Test**  
  Verify agent run token auth works for list/get routes:
  - Valid token → 200 OK
  - Missing token → 401 Unauthorized
  - Invalid token → 401 Unauthorized
  - Token from different company → 403 Forbidden (or 404 for get route)

- [ ] **AC-AL4.3: Filter Test**  
  Verify `status` filter works:
  - `status: "pending"` → returns only pending approvals
  - `status: "approved"` → returns only approved approvals
  - `status: "rejected"` → returns only rejected approvals
  - `status: "all"` (default) → returns all approvals (any status)

- [ ] **AC-AL4.4: Limit Test**  
  Verify `limit` param works:
  - Default `50` → returns up to 50 results
  - `limit: 10` → returns up to 10 results
  - `limit: 1` → returns 1 result
  - `limit: 101` → capped at 100 or returns validation error

---

## Quality Gates (Test ACCEPT/HOLD)

| Gate | ACCEPT Condition | HOLD Condition |
|------|-----------------|----------------|
| **listApprovals tool exists** | Agent with `approvals` toolset can call `listApprovals(status: "all")` and receive a list of approvals | Tool is not registered, or returns 404/405/500 |
| **getApproval tool exists** | Agent can call `getApproval(approvalId: "d817e537")` and receive approval detail | Tool is not registered, or returns 404/500 for valid approval ID |
| **Auth via run token** | Agent run token authenticates GET `/api/companies/{companyId}/approvals` and `/api/companies/{companyId}/approvals/{id}` | Returns 401/403 with valid token, or allows access without token |
| **Status filter works** | `listApprovals(status: "pending")` returns only pending; `status: "approved"` returns only approved | Filter is ignored, or all approvals are always returned regardless of filter |
| **Response format matches mobile** | List/get return `requester`, `linkedIssues`, `payload`, `decidedAt` (same schema as `/api/mobile/approvals`) | Missing fields, or schema differs from mobile API |
| **Dedupe protocol documented** | Control-plane or approval docs require `listApprovals` check before `createApproval`; define "equivalent" heuristic | No documentation, or docs do not mention dedupe protocol |
| **Manual test passes** | CEO agent (TEST Demo) calls `listApprovals` → finds approved CFO approval → skips re-file | Agent cannot list approvals, or re-files despite approved match |

---

## Out of Scope

The following items are explicitly **out of scope** for this story:

- **MCP `list_approvals` changes**: The MCP server already has `list_approvals` — no changes needed
- **Mobile UI**: Mobile approval list is out of scope (already works via `/api/mobile/approvals`)
- **Auto-fulfill hires**: Automatically creating agent seats when board approves a hire (separate feature)
- **Company JWT auth for agents**: Agents use run-token auth, not company JWT (intentional separation)
- **Removing `createApproval`**: The create tool is unchanged; this story only **adds** list/read
- **Approval decision UI**: The `/approval` board UI is unchanged
- **HITLy integration**: HITLy gate behavior is unchanged (list/get return `hitlyApprovalId` if present)
- **Approval search by date range**: Only status/type/title search is in scope (date filters are nice-to-have)
- **Approval history/audit log**: The `activity_log` table is unchanged (approvals are already logged)
- **Approval deletion**: Agents cannot delete approvals (board/admin only)

---

## Implementation Notes for Dev

### Current State (Observed)

- **Agent toolset**: `approvals` exports only `createApprovalTool` (`packages/mastra/src/tools/role-tools.ts`)
- **API (POST)**: `/api/companies/{companyId}/approvals` route handles POST (create) with agent run-token auth
- **API (GET, mobile)**: `/api/mobile/approvals` route handles GET (list) with company JWT auth
- **Helper**: `listCompanyApprovals(companyId)` in `/apps/web/app/api/mobile/approvals/route.ts` — queries `approvals` table, joins `agents` and `issues`, returns enriched list
- **MCP**: `list_approvals` tool exists in `/apps/web/app/api/mcp/route.ts` (company session)

### Proposed Implementation

#### 1. Add GET Handler to Company Approvals Route

**File**: `apps/web/app/api/companies/[companyId]/approvals/route.ts`

- Add `export async function GET(req, { params })` handler
- Extract `companyId` from params
- Validate agent run token (same `validateRunToken` as POST)
- Parse query params: `status`, `limit`, `search`
- Call `listCompanyApprovals(companyId)` helper (import from mobile route or refactor to shared helper)
- Filter by status (if not `"all"`)
- Apply search filter (if provided): `approval.type` or `approval.payload.title` contains search string (case-insensitive)
- Apply limit (default 50, max 100)
- Return `NextResponse.json({ approvals })`

#### 2. Add GET Handler for Single Approval

**File**: `apps/web/app/api/companies/[companyId]/approvals/[approvalId]/route.ts` (new file)

- Add `export async function GET(req, { params })` handler
- Extract `companyId` and `approvalId` from params
- Validate agent run token (same as list)
- Call `listCompanyApprovals(companyId)` and find approval by ID
- Return 404 if not found or wrong company
- Return `NextResponse.json({ approval })`

#### 3. Add Tools to Role Toolset

**File**: `packages/mastra/src/tools/role-tools.ts`

- Add `listApprovalsTool`:
  - `id: 'listApprovals'`
  - Input: `{ status?, limit?, search? }`
  - Fetch: `GET /api/companies/${companyId}/approvals?status=...&limit=...&search=...`
  - Return: `{ approvals }` or error
- Add `getApprovalTool`:
  - `id: 'getApproval'`
  - Input: `{ approvalId }`
  - Fetch: `GET /api/companies/${companyId}/approvals/${approvalId}`
  - Return: `{ approval }` or error
- Update `ROLE_TOOLS.approvals` object:
  ```ts
  approvals: { createApprovalTool, listApprovalsTool, getApprovalTool }
  ```

#### 4. Update Control-Plane Skill

**File**: `packages/skills/control-plane/SKILL.md`

- Add section under "Board Governance" or similar:
  - Document `listApprovals` and `getApproval` tools
  - **Dedupe protocol**: Before `createApproval`, call `listApprovals(status: "all")` and check for equivalent approved/pending request
  - Define "equivalent": same type, similar title/summary, status is approved (recent) or pending
  - Example: CEO hiring CFO → list approvals → find approved "Hire CFO" → skip re-file, comment on issue with approval ID

#### 5. Update `createApprovalTool` Description

**File**: `packages/mastra/src/tools/role-tools.ts`

- Update `createApprovalTool` description to include:
  - "Before filing, call `listApprovals` to check for an equivalent approved or pending request. Do not re-file if an equivalent exists."

### Files Likely to Change

- **API (new)**: `apps/web/app/api/companies/[companyId]/approvals/[approvalId]/route.ts`
- **API (edit)**: `apps/web/app/api/companies/[companyId]/approvals/route.ts` (add GET handler)
- **Tools (edit)**: `packages/mastra/src/tools/role-tools.ts` (add `listApprovalsTool`, `getApprovalTool`)
- **Skill (edit)**: `packages/skills/control-plane/SKILL.md` (add dedupe protocol)
- **Helper (refactor)**: Optionally extract `listCompanyApprovals` to shared helper if not already reusable

### Equivalence Heuristic (For Dev)

An approval is "equivalent" if:
1. **Same type** (e.g., `"hire_agent"`)
2. **Similar title/summary**: Fuzzy match on `payload.title` or `payload.summary` (e.g., both mention "CFO" or "Chief Financial Officer")
3. **Status is approved** (within last 30 days) **or** status is pending (any age)

**Skip re-file** if equivalent exists. **OK to file** if no match or all prior requests were rejected.

**Implementation**: Agents perform this check via prompt discipline (no server-side enforcement). Dev implements list/get tools; agents follow dedupe protocol via skill/prompt.

---

## Test Scenario: Demo CFO Hire

**Precondition**: TEST Demo company, CEO agent with `approvals` toolset enabled. Board has approved "Hire Dedicated CFO" (approval ID `d817e537` or equivalent).

**Test Steps**:

1. **Setup**: CEO agent wakes with goal "Hire a dedicated CFO"
2. **Step 1 (List)**: CEO calls `listApprovals(status: "all", limit: 50, search: "CFO")`
   - **Expected**: Returns list including approved "Hire Dedicated CFO" approval (status: `"approved"`, requester: CEO, linkedIssues: [...])
3. **Step 2 (Get)**: CEO calls `getApproval(approvalId: "d817e537")`
   - **Expected**: Returns full approval with `status: "approved"`, `payload.title: "Hire Dedicated CFO"`, `decidedAt`, `linkedIssues`
4. **Step 3 (Dedupe)**: CEO evaluates goal, finds approved CFO approval, skips re-file
   - **Expected**: CEO comments on linked issue: "Found approved board approval [d817e537] for CFO hire. Will not re-file."
5. **Step 4 (New Request)**: CEO evaluates goal "Hire CMO"
   - **Expected**: CEO calls `listApprovals(search: "CMO")` → no match → proceeds with `createApproval` for CMO hire

**Expected Result**: CEO agent does **not** re-file CFO approval. Seat appearance (auto-fulfill) is out of scope — that's a separate feature.

**Actual Result (Before Fix)**: CEO cannot list approvals → re-files CFO approval → duplicate pending request → workflow stalled.

---

## Acceptance Test Checklist

- [ ] **AC-AL1.1**: `listApprovalsTool` registered in `ROLE_TOOLS.approvals`
- [ ] **AC-AL1.2**: Tool accepts `status`, `limit`, `search` params
- [ ] **AC-AL1.3**: GET `/api/companies/{companyId}/approvals` route with agent auth
- [ ] **AC-AL1.4**: Response includes `id`, `type`, `status`, `requester`, `linkedIssues`
- [ ] **AC-AL1.5**: Agent run token auth enforced (no company JWT)
- [ ] **AC-AL1.6**: Tool returns list or error
- [ ] **AC-AL2.1**: `getApprovalTool` registered in `ROLE_TOOLS.approvals`
- [ ] **AC-AL2.2**: Tool accepts `approvalId` param
- [ ] **AC-AL2.3**: GET `/api/companies/{companyId}/approvals/{approvalId}` route with agent auth
- [ ] **AC-AL2.4**: Response includes full approval detail (payload, note, priorStatuses)
- [ ] **AC-AL2.5**: Agent run token auth enforced; returns 404 for wrong company
- [ ] **AC-AL2.6**: Tool returns approval or error
- [ ] **AC-AL3.1**: Control-plane SKILL.md documents new tools + dedupe protocol
- [ ] **AC-AL3.2**: Equivalence heuristic defined (same type, similar title, approved/pending)
- [ ] **AC-AL3.3**: `createApprovalTool` description references dedupe protocol
- [ ] **AC-AL3.4**: Example scenario documented (CFO hire dedupe)
- [ ] **AC-AL4.1**: Manual test plan documented (CEO lists/gets CFO approval)
- [ ] **AC-AL4.2**: Auth test passes (valid/invalid token, wrong company)
- [ ] **AC-AL4.3**: Filter test passes (pending/approved/rejected/all)
- [ ] **AC-AL4.4**: Limit test passes (default 50, custom limit, max 100)

---

## References

- **Original Issue**: Demo hire loop — CEO re-filed "Hire Dedicated CFO" (d817e537) after board approval; seat never appeared
- **Priority**: P0 (blocks Demo workflow)
- **Affected Agent**: CEO agent (TEST Demo company)
- **Related Docs**: `AGENTS.md` (Governance and Approvals), `packages/skills/control-plane/SKILL.md`
- **Related API**: `/api/mobile/approvals` (mobile list), `/api/mcp/route.ts` (MCP `list_approvals`)
- **Related Code**: `packages/mastra/src/tools/role-tools.ts` (`createApprovalTool`), `apps/web/app/api/companies/[companyId]/approvals/route.ts` (POST handler)
