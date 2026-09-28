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

## Design Choice: Enhanced `listApprovals` vs Separate `searchApprovals`

**Decision**: Single **enhanced `listApprovals` tool** with robust server-side filtering (status, type, q, date ranges).

**Rationale**:
- **Simpler agent UX**: One tool for both "list pending" and "search for CFO hire" use cases
- **Fewer tool calls**: Agents don't need to learn when to use list vs search
- **Consistent API**: Single endpoint with optional filters (all filters default-friendly)
- **Avoids raw paging**: Agents use targeted filters (`type: "hire_agent", q: "CFO"`) to find relevant decisions without client-side filtering or paging through last-50 raw results

**Rejected Alternative**: Separate `searchApprovals` tool with filters + basic `listApprovals` without filters — adds complexity, forces agents to choose between two tools, and doesn't simplify the "check before createApproval" workflow.

---

## User Stories

### US-AL1: List/Search Approvals Tool

**As a** Tourbillon agent with the `approvals` toolset,

**I want to** search and filter past and current board approvals by status, type, and free-text query with **server-side filtering**,

**So that** I can efficiently find equivalent approved or pending requests (e.g., "Hire CFO") without paging through raw last-50 lists or doing client-side filtering.

---

#### Acceptance Criteria: US-AL1

- [ ] **AC-AL1.1: Tool Registration**  
  The `approvals` toolset exports a `listApprovalsTool` registered alongside `createApprovalTool` in `packages/mastra/src/tools/role-tools.ts`.

- [ ] **AC-AL1.2: Input Schema (Enhanced Filtering)**  
  The tool accepts the following **server-side** filters (all optional):
  - `status`: `"pending" | "approved" | "rejected" | "all"` (default: `"all"`)
  - `type`: string, exact match or prefix (e.g., `"hire_agent"`, `"request_board_approval"`)
  - `q`: string, free-text search against `payload.title`, `payload.summary`, and `note` (case-insensitive substring)
  - `createdAfter`: ISO 8601 date string, filter approvals created after this date
  - `decidedAfter`: ISO 8601 date string, filter approvals decided (approved/rejected) after this date
  - `limit`: integer, max results (default: `20`, max: `50`)

- [ ] **AC-AL1.3: Server-Side Filtering (Not Client-Side)**  
  All filters are applied **server-side** in the API route query logic. The API **must not** return unfiltered results and expect agents to filter client-side. Query params are honored and enforced (unlike mobile API, which reportedly ignores some filters today).

- [ ] **AC-AL1.4: API Route (List with Filtering)**  
  A new GET handler on `/api/companies/{companyId}/approvals` route:
  - Authenticates via agent run token (same `validateRunToken` as POST)
  - Parses query params: `status`, `type`, `q`, `createdAfter`, `decidedAfter`, `limit`
  - Builds Drizzle query with WHERE clauses for each provided filter
  - Orders by `createdAt DESC` (most recent first)
  - Applies `limit` (default 20, max 50)
  - Joins `agents` and `issues` for `requester` and `linkedIssues` (same as mobile API)
  - Returns JSON: `{ approvals: [...] }`

- [ ] **AC-AL1.5: Response Format**  
  Each approval object includes:
  - `id`, `type`, `status`, `createdAt`, `decidedAt`, `payload` (with `title`, `summary`, `note`)
  - `requester` — `{ id, name, urlKey }` of the requesting agent (null if agent deleted)
  - `linkedIssues` — array of `{ id, identifier, title, status, boardApprovalId }` (same as mobile API)
  - Optional: `hitlyApprovalId`, `hitlyError` (if HITLy gate is enabled)

- [ ] **AC-AL1.6: Auth & Permissions**  
  - Agent run token is required (same as `createApproval`)
  - No company JWT required (agents authenticate via run token, not human session)
  - Agent can only list approvals for their own company (enforced by `companyId` in token)

- [ ] **AC-AL1.7: Tool Output**  
  The tool returns the full list of approvals matching the filters, or an error if the API call fails (same pattern as `listAgentsTool`).

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
  - `listApprovals` — search/filter past/pending approvals by status, type, free-text query (`q`), date ranges
  - `getApproval` — fetch full approval detail by ID
  - **Protocol**: Before calling `createApproval` for hire/spend, the agent **must** call `listApprovals` with targeted filters (e.g., `type: "hire_agent", q: "CFO"`) and check if an equivalent approval exists.
  - **UX Design**: Single enhanced `listApprovals` tool (not separate `searchApprovals`) — agents use the same tool for both "list pending" and "search for CFO hire" use cases.

- [ ] **AC-AL3.2: Equivalence Heuristic (Documented)**  
  The documentation defines "equivalent approval" for dedupe purposes:
  - Same `type` (e.g., `"hire_agent"`)
  - Similar `payload.title` or `payload.summary` (fuzzy match: same key terms, same role/amount/action)
  - Status is `"approved"` (within last 30 days) or `"pending"` (any age)
  - **Skip re-file** if equivalent approved or pending approval exists
  - **OK to file** if no equivalent exists, or if all prior requests were `"rejected"`

- [ ] **AC-AL3.3: Tool Description Update**  
  The `listApprovalsTool` and `createApprovalTool` description strings are updated:
  - `listApprovals`: "Search and filter board approvals by status, type, or free-text query. Use targeted filters (type + q) to find prior decisions before filing a new request."
  - `createApproval`: "Before filing, call `listApprovals` with targeted filters (e.g., `type: 'hire_agent', q: 'CFO'`) to check for an equivalent approved or pending request. Do not re-file if an equivalent exists."

- [ ] **AC-AL3.4: Examples in Docs**  
  The control-plane or approval-specific documentation includes an example:
  - **Scenario**: Agent wants to hire a CFO
  - **Step 1**: Call `listApprovals(type: "hire_agent", q: "CFO", status: "all", limit: 20)`
  - **Step 2**: If match found with `status: "approved"` (recent) or `"pending"` → **skip re-file**, comment on linked issue referencing approval ID
  - **Step 3**: If no match → proceed with `createApproval`
  - **Why targeted filters**: Avoids paging raw last-50; server filters to relevant hire/CFO decisions only

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

- [ ] **AC-AL4.3: Filter Test (Server-Side)**  
  Verify all filters work **server-side** (not client-side):
  - `status: "pending"` → returns only pending approvals
  - `status: "approved"` → returns only approved approvals
  - `status: "rejected"` → returns only rejected approvals
  - `status: "all"` (default) → returns all approvals (any status)
  - `type: "hire_agent"` → returns only hire_agent approvals (exact match)
  - `q: "CFO"` → returns approvals with "CFO" in title/summary/note (case-insensitive)
  - `createdAfter: "2026-01-01"` → returns approvals created after Jan 1, 2026
  - `decidedAfter: "2026-01-01"` → returns approvals decided after Jan 1, 2026
  - Combined filters (e.g., `type: "hire_agent", q: "CFO", status: "approved"`) → returns intersection

- [ ] **AC-AL4.4: Limit Test**  
  Verify `limit` param works:
  - Default `20` → returns up to 20 results
  - `limit: 10` → returns up to 10 results
  - `limit: 1` → returns 1 result
  - `limit: 51` → capped at 50 or returns validation error
  - `limit: 0` or negative → returns validation error or defaults to 20

---

## Quality Gates (Test ACCEPT/HOLD)

| Gate | ACCEPT Condition | HOLD Condition |
|------|-----------------|----------------|
| **listApprovals tool exists** | Agent with `approvals` toolset can call `listApprovals(status: "all")` and receive a filtered list | Tool is not registered, or returns 404/405/500 |
| **getApproval tool exists** | Agent can call `getApproval(approvalId: "d817e537")` and receive approval detail | Tool is not registered, or returns 404/500 for valid approval ID |
| **Auth via run token** | Agent run token authenticates GET `/api/companies/{companyId}/approvals` and `/api/companies/{companyId}/approvals/{id}` | Returns 401/403 with valid token, or allows access without token |
| **Server-side filtering works** | All filters (`status`, `type`, `q`, `createdAfter`, `decidedAfter`) are applied server-side; API honors query params | Filters ignored, or client-side filtering expected, or API returns unfiltered results |
| **Type filter works** | `listApprovals(type: "hire_agent")` returns only hire_agent approvals (exact match) | Filter ignored or substring-matched incorrectly |
| **Free-text query works** | `listApprovals(q: "CFO")` returns approvals with "CFO" in title/summary/note (case-insensitive) | Filter ignored or fails to match expected records |
| **Date filters work** | `createdAfter` and `decidedAfter` filter correctly by ISO 8601 date | Filters ignored or parse errors on valid dates |
| **Response format matches mobile** | List/get return `requester`, `linkedIssues`, `payload`, `decidedAt` (same schema as `/api/mobile/approvals`) | Missing fields, or schema differs from mobile API |
| **Dedupe protocol documented** | Control-plane docs require `listApprovals` with targeted filters before `createApproval`; UX choice (enhanced single tool) documented | No documentation, or separate searchApprovals tool created without clear rationale |
| **Manual test passes** | CEO agent (TEST Demo) calls `listApprovals(type: "hire_agent", q: "CFO")` → finds approved CFO approval → skips re-file | Agent cannot filter effectively, or re-files despite approved match |

---

## Out of Scope

The following items are explicitly **out of scope** for this story:

- **MCP `list_approvals` changes**: The MCP server already has `list_approvals` — no changes needed (though mobile/MCP may benefit from same server-side filtering later)
- **Mobile UI**: Mobile approval list is out of scope (already works via `/api/mobile/approvals`)
- **Auto-fulfill hires**: Automatically creating agent seats when board approves a hire (separate feature)
- **Company JWT auth for agents**: Agents use run-token auth, not company JWT (intentional separation)
- **Removing `createApproval`**: The create tool is unchanged; this story only **adds** list/read
- **Approval decision UI**: The `/approval` board UI is unchanged
- **HITLy integration**: HITLy gate behavior is unchanged (list/get return `hitlyApprovalId` if present)
- **Approval history/audit log**: The `activity_log` table is unchanged (approvals are already logged)
- **Approval deletion**: Agents cannot delete approvals (board/admin only)
- **Pagination/cursor**: First iteration uses `limit` only; cursor-based pagination is nice-to-have for large approval lists

---

## Implementation Notes for Dev

### Current State (Observed)

- **Agent toolset**: `approvals` exports only `createApprovalTool` (`packages/mastra/src/tools/role-tools.ts`)
- **API (POST)**: `/api/companies/{companyId}/approvals` route handles POST (create) with agent run-token auth
- **API (GET, mobile)**: `/api/mobile/approvals` route handles GET (list) with company JWT auth
- **Helper**: `listCompanyApprovals(companyId)` in `/apps/web/app/api/mobile/approvals/route.ts` — queries `approvals` table, joins `agents` and `issues`, returns enriched list
- **MCP**: `list_approvals` tool exists in `/apps/web/app/api/mcp/route.ts` (company session)

### Proposed Implementation

#### 1. Add GET Handler to Company Approvals Route (Server-Side Filtering)

**File**: `apps/web/app/api/companies/[companyId]/approvals/route.ts`

- Add `export async function GET(req, { params })` handler
- Extract `companyId` from params
- Validate agent run token (same `validateRunToken` as POST)
- Parse query params: `status`, `type`, `q`, `createdAfter`, `decidedAfter`, `limit`
- Build Drizzle query with **server-side** WHERE clauses:
  - `status`: `eq(approvals.status, status)` if not `"all"`
  - `type`: `eq(approvals.type, type)` or `like(approvals.type, `${type}%`)` for prefix match
  - `q`: `or(ilike(approvals.payload->>'title', `%${q}%`), ilike(approvals.payload->>'summary', `%${q}%`), ilike(approvals.note, `%${q}%`))`
  - `createdAfter`: `gte(approvals.createdAt, new Date(createdAfter))`
  - `decidedAfter`: `gte(approvals.decidedAt, new Date(decidedAfter))`
- Join `agents` and `issues` for `requester` and `linkedIssues` (same as mobile)
- Order by `desc(approvals.createdAt)` (most recent first)
- Apply `limit` (default 20, max 50, clamp invalid values)
- Return `NextResponse.json({ approvals })`
- **Do NOT** call `listCompanyApprovals` and filter client-side — this defeats the purpose of targeted server-side filtering

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
  - Description: "Search and filter board approvals by status, type, or free-text query. Use targeted filters (type + q) to find prior decisions before filing a new request."
  - Input: `{ status?, type?, q?, createdAfter?, decidedAfter?, limit? }`
  - Fetch: `GET /api/companies/${companyId}/approvals` with query params
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
  - Document `listApprovals` and `getApproval` tools with full filter options
  - **UX Design Choice**: Single enhanced `listApprovals` tool (not separate `searchApprovals`) — use for both "list pending" and "search for CFO hire"
  - **Dedupe protocol**: Before `createApproval`, call `listApprovals` with **targeted filters** (e.g., `type: "hire_agent", q: "CFO"`) to find equivalent approved/pending requests
  - Define "equivalent": same type, similar title/summary (via `q` filter), status is approved (recent) or pending
  - Example: CEO hiring CFO → `listApprovals(type: "hire_agent", q: "CFO", status: "all", limit: 20)` → find approved "Hire CFO" → skip re-file, comment on issue with approval ID
  - **Why targeted filters**: Avoids paging raw last-50; server filters to relevant decisions only

#### 5. Update Tool Descriptions

**File**: `packages/mastra/src/tools/role-tools.ts`

- Update `listApprovalsTool` description:
  - "Search and filter board approvals by status, type, or free-text query. Use targeted filters (type + q) to find prior decisions before filing a new request."
- Update `createApprovalTool` description:
  - "Before filing, call `listApprovals` with targeted filters (e.g., `type: 'hire_agent', q: 'CFO'`) to check for an equivalent approved or pending request. Do not re-file if an equivalent exists."

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
2. **Step 1 (Targeted Filter)**: CEO calls `listApprovals(type: "hire_agent", q: "CFO", status: "all", limit: 20)`
   - **Expected**: Returns list including approved "Hire Dedicated CFO" approval (status: `"approved"`, requester: CEO, linkedIssues: [...])
   - **Verify**: Server-side filtering works — only hire_agent approvals with "CFO" in title/summary are returned (not all 50 approvals)
3. **Step 2 (Get)**: CEO calls `getApproval(approvalId: "d817e537")`
   - **Expected**: Returns full approval with `status: "approved"`, `payload.title: "Hire Dedicated CFO"`, `decidedAt`, `linkedIssues`
4. **Step 3 (Dedupe)**: CEO evaluates goal, finds approved CFO approval, skips re-file
   - **Expected**: CEO comments on linked issue: "Found approved board approval [d817e537] for CFO hire. Will not re-file."
5. **Step 4 (New Request)**: CEO evaluates goal "Hire CMO"
   - **Expected**: CEO calls `listApprovals(type: "hire_agent", q: "CMO", status: "all")` → no match → proceeds with `createApproval` for CMO hire

**Expected Result**: CEO agent does **not** re-file CFO approval. Seat appearance (auto-fulfill) is out of scope — that's a separate feature.

**Actual Result (Before Fix)**: CEO cannot list approvals → re-files CFO approval → duplicate pending request → workflow stalled.

---

## Acceptance Test Checklist

- [ ] **AC-AL1.1**: `listApprovalsTool` registered in `ROLE_TOOLS.approvals`
- [ ] **AC-AL1.2**: Tool accepts `status`, `type`, `q`, `createdAfter`, `decidedAfter`, `limit` params (all optional)
- [ ] **AC-AL1.3**: Server-side filtering enforced (not client-side); API honors all query params
- [ ] **AC-AL1.4**: GET `/api/companies/{companyId}/approvals` route with agent auth and filtering
- [ ] **AC-AL1.5**: Response includes `id`, `type`, `status`, `requester`, `linkedIssues`, `payload` (with `note`)
- [ ] **AC-AL1.6**: Agent run token auth enforced (no company JWT)
- [ ] **AC-AL1.7**: Tool returns filtered list or error
- [ ] **AC-AL2.1**: `getApprovalTool` registered in `ROLE_TOOLS.approvals`
- [ ] **AC-AL2.2**: Tool accepts `approvalId` param
- [ ] **AC-AL2.3**: GET `/api/companies/{companyId}/approvals/{approvalId}` route with agent auth
- [ ] **AC-AL2.4**: Response includes full approval detail (payload, note, priorStatuses)
- [ ] **AC-AL2.5**: Agent run token auth enforced; returns 404 for wrong company
- [ ] **AC-AL2.6**: Tool returns approval or error
- [ ] **AC-AL3.1**: Control-plane SKILL.md documents new tools + dedupe protocol + UX choice (enhanced single tool)
- [ ] **AC-AL3.2**: Equivalence heuristic defined (same type, similar title, approved/pending)
- [ ] **AC-AL3.3**: `listApprovalsTool` and `createApprovalTool` descriptions reference targeted filtering and dedupe protocol
- [ ] **AC-AL3.4**: Example scenario documented (CFO hire dedupe with targeted filters: `type: "hire_agent", q: "CFO"`)
- [ ] **AC-AL4.1**: Manual test plan documented (CEO lists/gets CFO approval with filters)
- [ ] **AC-AL4.2**: Auth test passes (valid/invalid token, wrong company)
- [ ] **AC-AL4.3**: Filter test passes (status, type, q, createdAfter, decidedAfter — all server-side)
- [ ] **AC-AL4.4**: Limit test passes (default 20, custom limit, max 50, validation errors)

---

## References

- **Original Issue**: Demo hire loop — CEO re-filed "Hire Dedicated CFO" (d817e537) after board approval; seat never appeared
- **Priority**: P0 (blocks Demo workflow)
- **Affected Agent**: CEO agent (TEST Demo company)
- **Related Docs**: `AGENTS.md` (Governance and Approvals), `packages/skills/control-plane/SKILL.md`
- **Related API**: `/api/mobile/approvals` (mobile list), `/api/mcp/route.ts` (MCP `list_approvals`)
- **Related Code**: `packages/mastra/src/tools/role-tools.ts` (`createApprovalTool`), `apps/web/app/api/companies/[companyId]/approvals/route.ts` (POST handler)
