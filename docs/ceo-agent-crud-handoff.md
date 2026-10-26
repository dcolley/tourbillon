# Handoff: CEO Agent Management CRUD Tools

**For:** Dev + Test  
**Stories:** `/workspace/briefings/stories-ceo-agent-crud.md`  
**Repo:** `dcolley/tourbillon`  
**Date:** 2026-10-01 (BST)

---

## What to build

Expose **Mastra tools** so CEO (config-gated) can manage company agents: get detail, pause/enable/archive, heartbeat, profile, model, capabilities. Mirror Board/MCP behavior via **run-token** HTTP, not cookies/MCP JWT.

### Priority

| Priority | Deliverables |
|----------|----------------|
| **P0** | Run-token GET/PATCH agent routes; `getAgent`; `setAgentActive`; `setAgentHeartbeat`; `updateAgentProfile`; split `agent-management` toolset; CEO defaults + `manage-agents` skill; safety (self-pause, last CEO); tests + Demo |
| **P1** | `updateAgentModel`; `updateAgentCapabilities` (+ escalation `reason`) |
| **P2** | `setAgentOm` |

### Do not build (MVP)

- Hard delete as agent tool  
- `wake_agent` as Mastra tool  
- Wiring agents to call `/api/mcp` or mobile session PATCH  
- Budget/secrets/clone tools  

---

## Repo paths

| Area | Path |
|------|------|
| Story pattern | `docs/stories-create-agent-tool.md` |
| Mastra tools | `packages/mastra/src/tools/role-tools.ts` |
| Tool assembly | `packages/mastra/src/agent-factory.ts` |
| Defaults / catalog | `packages/shared/src/constants.ts`, `packages/shared/src/tool-catalog.ts` |
| Lib (reuse) | `apps/web/lib/agents.ts` |
| **New** run-token API | `apps/web/app/api/companies/[companyId]/agents/[agentId]/route.ts` |
| Existing list/create | `apps/web/app/api/companies/[companyId]/agents/route.ts` |
| Mobile PATCH (reference only) | `apps/web/app/api/mobile/agents/[urlKey]/route.ts` |
| Board actions (reference) | `apps/web/app/(dashboard)/agent/actions.ts` |
| MCP ops (reference) | `apps/web/app/api/mcp/route.ts`, `docs/mcp-control-plane.md` |
| Schema status enum | `packages/db/src/schema/agents.ts` |
| Skill (new) | `packages/skills/manage-agents/SKILL.md` |
| Tests | `packages/mastra/src/tools/role-tools.test.ts`, new route tests under `apps/web/app/api/companies/.../agents/` |

---

## Implementation recipe (Dev)

1. **US-AM1** — Add `GET`/`PATCH` under `.../agents/[agentId]` with `validateRunToken` + company check. Delegate to existing lib (`setAgentActive` / widen for `archived`, `updateAgentRuntimeConfig`, `updateAgentProfile`, `updateAgentInstructions`, `updateAgentModel`, `updateAgentCapabilities`, `updateAgentObservationalMemory`). Enforce: same-company only; no self-pause; no pause/archive last active CEO; reject `pending_approval`.
2. **US-AM2** — `getAgent` on **roster**.
3. **US-AM3–5** — Mutation tools on **`agent-management`** (stop aliasing to roster).
4. **US-AM8** — `TOOLSET_CATALOG` + CEO `ROLE_DEFAULT_TOOLSETS` / skills; `manage-agents` SKILL.md; plan for existing CEO seats (migration or manual Capabilities).
5. **US-AM6–7** — Model + capabilities; require `reason` on privilege grants.
6. **US-AM9** — Unit + integration + Demo script in story doc.

Pattern for tools: same as `createAgentTool` — `extractToolRuntimeContext` + `tracedAgentFetch`.

---

## Test gates (ACCEPT / HOLD)

| Gate | ACCEPT | HOLD |
|------|--------|------|
| Run-token PATCH | Pause/heartbeat/profile persist; UI matches | Mutations only via Board |
| CEO tools | CEO wake has management tools | Missing toolset |
| PM/CTO tools | roster read/create only; **no** pause | Can pause teammates |
| Self-pause | 400 | CEO pauses self |
| Last CEO | 400 | Zero active CEOs |
| Cross-company | 403/404 | Leak |
| Demo | CEO pauses CMO, enables Engineer heartbeat, edits title; PM signs off | Incomplete |

Full AC: see `stories-ceo-agent-crud.md` US-AM1–AM9.

---

## API gaps discovered (must fix in US-AM1)

1. **No** `GET`/`PATCH /api/companies/{companyId}/agents/{agentId}` for run tokens — only collection GET/POST.
2. Mutations exist in **lib** + **Board server actions** + **mobile PATCH** (session) + **MCP** (`X-Company-Token`) — none of these are callable by agent run tokens today.
3. `setAgentActive` lib maps boolean → `active|paused` only; **`archived` not wired** through that helper (schema supports it).
4. `ROLE_TOOLS['agent-management']` is currently a **legacy alias of roster** (same object) — must become write-only toolset.
5. `agent-management` **not** in `TOOLSET_CATALOG` yet.
6. Hard `deleteAgent` exists for Board/mobile — keep out of agent tools.

---

## Open PM decisions — LOCKED (see bottom)

1. Self-pause: hard forbid (recommended) vs confirmation/approval flow.  
2. Capability escalation: required `reason` (MVP) vs board approval.  
3. `listAgents` hide archived by default?  
4. Auto-migrate existing CEO toolsets/skills vs manual UI toggle.  
5. Include `runtimeType`/harness in P0 profile tool or defer.  

---

## Done when

- P0 stories ACCEPT (routes + tools + gating + Demo).  
- P1 ACCEPTed or explicitly deferred with ticket.  
- Story doc linked from `docs/README.md` when landing in repo (optional follow-up PR).

---

## Locked PM decisions (2026-10-01)

1. **Self-pause:** hard forbid (`400 self_pause_forbidden`). Board/approval path only for pausing the calling agent.
2. **Capability escalation:** MVP allows grants with required `reason` string (traced); board approval for high-risk grants is post-MVP.
3. **listAgents:** hide `archived` by default; add optional `includeArchived: boolean` (default false).
4. **Existing CEO seats:** include a one-time / deploy note to grant `agent-management` + `manage-agents` skill on Demo CEO (and any existing CEO seats) — do not rely only on ROLE_DEFAULT for new hires.
5. **runtimeType / harness:** deferred from P0 `updateAgentProfile`; optional P1+ field if cheap, else separate ticket.
