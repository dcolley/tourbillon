# Chat ↔ Heartbeat Tool Parity + Compact Tool Discovery

**Document Version**: 1.0  
**Last Updated**: 2026-10-01 (BST)  
**Status**: Draft — Ready for Dev / Test  
**Owner**: PM:Tourbillon (Derek)  
**Repo**: `dcolley/tourbillon` (main @ research time, SHA `9237ced`)

---

## Overview

Dashboard **chat** must expose the **same assigned tools** as **heartbeat**. Capabilities (assigned toolsets / tools / MCP) is the source of truth — chat must not secretly strip toolsets. Separately, agents need compact discovery meta-tools (`listTools` / `getToolDetails`) mirroring the existing `listSkills` / `getSkill` pattern so full schemas do not dominate context by default.

### Product lock (Derek / PM:Tourbillon)

1. **Tool assignment parity** — heartbeat and chat use the same eligibility (`assembleAgentTools` / Capabilities).
2. **Compact discovery** — agent should use `listTools` + `getToolDetails` (aliases ok: `list_tools` / `get_tool_details`) so full MCP/tool schemas do not blow context by default.
3. **Assigned tools stay valid in both modes** — once known, tools remain directly callable (no forced `invokeTool` indirection for MVP).
4. **Context reality** — models can be ~64k; do not over-optimize. Compact discovery is still required; compact-schema registration is a follow-up if schemas still blow 64k.
5. **Chat behavior rules stay** — no heartbeat inbox/EXIT ritual; don't mutate unless asked — but **do not** secretly strip assigned toolsets.

### Problem Statement

**Severity:** P0 (chat cannot use Capabilities the operator checked)

**Current State (verified on main):**

`packages/mastra/src/chat-controller.ts`:

1. **`CHAT_EXCLUDED_TOOLSETS`** drops: `web-search`, `web-search-tavily`, `approvals`, `buffer`, `nitter`, `code-execution`, `knowledge-graph`.
2. **`CHAT_ALLOWED_TOOL_IDS`** further allowlists a small set (identity/inbox-ish + workspace read + skills + goals/projects + mail).
3. **`assembleChatTools`** filters `assignedToolsets` through the exclusion set, then runs `filterChatTools` on the result.
4. Comment claims this is for modest context (e.g. 4k) — outdated vs ~64k and vs product lock.
5. **Heartbeat** uses full `assembleAgentTools` with no chat filters.
6. Skills already have on-demand discovery (`listSkills` / `getSkill` in Tier-1 via `CONTROL_PLANE_TOOLS` ← `SKILL_TOOLS`) — **tools have no equivalent**.

**Operator-visible bug:** CEO with `web-search` checked in Capabilities can search in heartbeat but **not** in dashboard chat.

### Expected Outcome

- Chat and heartbeat register the **same** tools for a given agent config.
- `listTools` / `getToolDetails` always available (Tier-1).
- Chat mode instructions preserved (no wake ritual / no unsolicited mutations).
- Demo: CEO chat with web-search checked can search; heartbeat unchanged; meta-tools work.

### Related Links

| Resource | Path / note |
|----------|-------------|
| Bug + chat assembly | `packages/mastra/src/chat-controller.ts` (`assembleChatTools`, `filterChatTools`, `CHAT_*`) |
| Heartbeat assembly | `packages/mastra/src/agent-factory.ts` (`assembleAgentTools`) |
| Skill meta-tools (pattern) | `packages/mastra/src/tools/skill-tools.ts` |
| On-demand skills | `packages/mastra/src/skills/on-demand-skills.ts` |
| Tier-1 control plane | `packages/mastra/src/tools/control-plane-tools.ts` (`CONTROL_PLANE_TOOLS` spreads `SKILL_TOOLS`) |
| Role / capability tools | `packages/mastra/src/tools/role-tools.ts`, `packages/shared/src/tool-catalog.ts` |
| Agent CRUD stories (out of scope) | `/workspace/briefings/stories-ceo-agent-crud.md` (#72 separate) |

---

## Context

### How skills discovery works today (mirror this)

| Piece | Behavior |
|-------|----------|
| `listSkills` | Returns assigned skills: slug + short description (+ approxChars / baked flags) |
| `getSkill(slug)` | Returns full markdown body for one skill |
| Prompt | Catalog section instructs agent to call list/get before following methodology |
| Registration | Full skill bodies are **not** all inlined; tools are always present in `CONTROL_PLANE_TOOLS` |
| Chat | Uses `formatChatSkillsCatalogSection`; still has `listSkills`/`getSkill` in allowlist |

### How tools work today (gap)

| Mode | Assembly | Result |
|------|----------|--------|
| Heartbeat | `assembleAgentTools` | Tier-1 + assigned toolsets + assignable tools + MCP (env gates for searx/tavily/code) |
| Chat | `assembleChatTools` → exclude toolsets → `filterChatTools` allowlist | Secretly reduced set |

There is **no** `listTools` / `getToolDetails`. Agents discover tools only via provider-registered schemas (and a thin "Prefer: …" line in the chat system prompt).

### Provider payload strategy (PM preference — locked for MVP)

| Option | Description | MVP? |
|--------|-------------|------|
| **(A)** Register full assigned tools with the model; instruct agents to prefer `listTools`/`getToolDetails` for discovery | Assigned tools stay **directly callable** once known | **Yes — prefer** |
| **(B)** Register only meta-tools + thin `invokeTool` wrapper | Extra indirection; harder UX | No for MVP |
| **Follow-up** | Compact schema mode if full schemas still blow ~64k | Allowed later; not required for MVP |

**MVP statement:** Same tools registered in chat + heartbeat; add `listTools`/`getToolDetails`; remove chat filters. Keep chat behavior rules in the system prompt.

---

## Stories

### US-CTP1 — Remove chat secret allowlist / exclusions (parity)

**Priority:** P0  
**Type:** Bugfix / Product parity

#### User story

As an operator configuring an agent’s Capabilities, I want dashboard chat to use the same tools as heartbeat, so checking web-search (or any toolset) actually works in both modes.

#### Acceptance criteria

1. **Remove** `CHAT_EXCLUDED_TOOLSETS`, `CHAT_ALLOWED_TOOL_IDS`, and `filterChatTools` (or leave dead code deleted — no remaining call sites).
2. **Chat tool assembly** calls the same eligibility path as heartbeat: `assembleAgentTools(agentRecord, options)` (or a thin wrapper that does not strip toolsets / MCP / allowlist).
3. Chat still clears/disables nothing that heartbeat would keep for the same record + company settings (searx/tavily/code env gates remain shared inside `assembleAgentTools`).
4. **Keep** `CHAT_MODE_INSTRUCTIONS` (and chat skills catalog / no control-plane inline in chat) — behavior rules only; not tool stripping.
5. `createChatAgentWithSkills` / `createChatController` log tool ids reflect full assigned set (minus shared env gates).
6. Comment that claimed “4k context” allowlist is removed or rewritten to document parity + discovery meta-tools.

#### Implementation notes

- Primary file: `packages/mastra/src/chat-controller.ts`.
- Prefer deleting `assembleChatTools`’s custom filtering and calling `assembleAgentTools` directly from `createChatAgentWithSkills`.
- Do **not** zero `mcpServerIds` in chat if heartbeat would attach MCP for that agent (`assembleChatTools` currently forces `mcpServerIds: []` — that is also a secret strip; remove it).
- Workspace: chat may still use `buildChatWorkspace()` (tools-disabled sandbox) if that only avoids sandbox schema inflation — confirm it does not remove assigned code-execution **tools** that heartbeat would have via toolsets. If code-execution requires heartbeat’s workspace attach, document and align with `shouldAttachCodeExecutionWorkspace` or defer as follow-up — MVP must not silently drop the `code-execution` **toolset** from assignment eligibility; if runtime workspace differs, call that out in PR.

#### Out of scope

- Capabilities UI changes.
- Agent CRUD (#72 / CEO management stories).

---

### US-CTP2 — Add `listTools` + `getToolDetails` meta-tools (Tier-1)

**Priority:** P0  
**Type:** Feature (mirror skills)

#### User story

As an agent (chat or heartbeat), I want to list my tools with one-line descriptions and fetch full schema for one tool on demand, so I do not need every tool’s full JSON schema explained in the prompt — and so discovery stays compact on ~64k models.

#### Acceptance criteria

1. New tools (names preferred; snake_case aliases optional if needed for providers):
   - **`listTools`** — returns for each available tool: `id`, one-line `description`, optional `toolset` (or tier / source).
   - **`getToolDetails`** — input `{ id: string }`; returns full description + input schema (and output schema if cheap) for that one id; `tool_not_found` + available ids if missing.
2. Both are **always available** — Tier-1 control-plane (same path as `listSkills`/`getSkill`: add to a small `TOOL_DISCOVERY_TOOLS` object and spread into `CONTROL_PLANE_TOOLS`, or equivalent).
3. Catalog is scoped to tools the agent **actually has** after `assembleAgentTools` eligibility (assigned + Tier-1 + env gates) — not the global universe of every possible tool.
4. Document in tool descriptions **when to call**:
   - Call `listTools` when unsure what capabilities you have or before exploring unfamiliar MCP/search tools.
   - Call `getToolDetails(id)` before first use of a tool whose parameters you do not know.
   - Prefer calling the tool **directly** once known (no invoke wrapper required).
5. Optional prompt hint (chat + heartbeat): short “Tools (on demand)” note pointing at `listTools`/`getToolDetails` — do not dump full schemas into the system prompt.
6. Unit tests for list/get against a fixture agent with a known toolset mix (e.g. control-plane + web-search).

#### Implementation notes (pattern to mirror)

| Skills | Tools (this story) |
|--------|-------------------|
| `packages/mastra/src/tools/skill-tools.ts` | New e.g. `packages/mastra/src/tools/tool-discovery-tools.ts` |
| `listSkillCatalogForAgent` / `getSkillContentForAgent` | Helpers that introspect assembled tool objects (`id`, `description`, `inputSchema`) |
| Spread into `CONTROL_PLANE_TOOLS` via `SKILL_TOOLS` | Spread via `TOOL_DISCOVERY_TOOLS` |

**Schema serialization:** Zod → JSON Schema (or Mastra’s existing tool schema export) for `getToolDetails`. Keep one-line descriptions truncated (~200–240 chars) in `listTools`, matching `extractSkillDescription` spirit.

**Self-reference:** `listTools` / `getToolDetails` appear in the catalog (or are documented as baked Tier-1 like control-plane skill).

#### Out of scope

- Forcing all calls through `invokeTool`.
- Compact schema registration mode (follow-up if 64k still overflows).

---

### US-CTP3 — Provider payload strategy (MVP = A)

**Priority:** P0 (policy + wiring)  
**Type:** Decision + light prompt/docs

#### User story

As PM/Dev, I want a clear MVP strategy for how tools are registered with the model provider so chat/heartbeat stay usable without schema blowups or forced indirection.

#### Locked decision

| Item | Choice |
|------|--------|
| Registration | **(A)** Register **full** assigned tools with the model in both chat and heartbeat |
| Discovery | Always register `listTools` + `getToolDetails`; instruct agents to prefer them for discovery |
| Invocation | Tools remain **directly callable** once known — **do not** require `invokeTool` |
| Follow-up | If schemas still blow ~64k in practice, allow **compact schema mode** (register thin stubs + details on demand) as a later story — not MVP |

#### Acceptance criteria

1. Story/PR description states MVP = parity + meta-tools; option B deferred.
2. Chat system prompt “Prefer: …” line either lists a short sample + points to `listTools`, or is replaced by a compact tools catalog section (ids + one-liners capped), not a full schema dump.
3. Heartbeat prompt does not need a full tool schema dump either; discovery tools + provider registration suffice.
4. No new `invokeTool` wrapper in MVP.

#### Out of scope

- Implementing option B.
- Implementing compact-schema registration (ticket later if needed).

---

### US-CTP4 — Tests + Demo

**Priority:** P0  
**Type:** Verification

#### User story

As Test/PM, I want automated coverage and a short Demo script proving chat/heartbeat parity and meta-tools, so we do not regress the secret allowlist.

#### Acceptance criteria

**Automated**

1. Unit: chat assembly for an agent with `web-search` (and/or `web-search-tavily`) **includes** search tools; heartbeat assembly for same record matches on tool ids (set equality after shared env gates).
2. Unit: agent **without** web-search does not get search tools in either mode.
3. Unit: `listTools` returns compact entries; `getToolDetails('webSearch')` (or actual id) returns schema; unknown id → error + available ids.
4. Unit/regression: `CHAT_EXCLUDED_TOOLSETS` / `CHAT_ALLOWED_TOOL_IDS` / `filterChatTools` are gone (or tests fail if reintroduced).
5. Existing skill list/get tests still pass; control-plane still includes skill + tool discovery tools.

**Demo script (manual / Demo company)**

| Step | Action | Expect |
|------|--------|--------|
| 1 | Open Demo CEO → Capabilities → confirm **web-search** checked | UI shows assigned |
| 2 | Dashboard **chat** as CEO: “Search the web for today’s top AI news headline” | Agent calls search tool(s); returns results (not “I don’t have web search”) |
| 3 | Same agent **heartbeat** / wake | Search still works; control-plane ritual unchanged |
| 4 | Chat: “What tools do you have?” → agent uses `listTools` | Compact list includes search + Tier-1 |
| 5 | Chat: “Show me the schema for \<search tool id\>” → `getToolDetails` | Full schema returned |
| 6 | Chat: ask a question that needs no mutation | No unsolicited issue checkout / EXIT / sendToAgent |

**Sign-off:** PM ACCEPT when Demo steps 2–5 pass and automated tests green.

---

## Out of scope (all stories)

- Changing Capabilities UI.
- #72 / CEO agent CRUD (`stories-ceo-agent-crud.md`) — separate track.
- Option B invoke-wrapper architecture.
- Compact schema registration mode (follow-up only).
- Changing chat behavior rules (inbox/EXIT / mutate-unless-asked).

---

## Suggested file / touch map

| Area | Path |
|------|------|
| Remove chat filters | `packages/mastra/src/chat-controller.ts` |
| Heartbeat assembly (reference) | `packages/mastra/src/agent-factory.ts` |
| New discovery tools | `packages/mastra/src/tools/tool-discovery-tools.ts` (new) |
| Wire Tier-1 | `packages/mastra/src/tools/control-plane-tools.ts` |
| Pattern reference | `packages/mastra/src/tools/skill-tools.ts`, `packages/mastra/src/skills/on-demand-skills.ts` |
| Tests | `packages/mastra/src/chat-controller.test.ts` (new or extend), `packages/mastra/src/tools/tool-discovery-tools.test.ts` (new) |

---

## Open questions — LOCKED

1. **Parity:** Capabilities is SoT; chat must not strip assigned toolsets/MCP.  
2. **MVP payload:** Option A (full tools registered + list/get for discovery).  
3. **Invocation:** Direct tool calls; no forced invokeTool.  
4. **Context:** ~64k assumed; compact discovery required; compact schemas follow-up only if needed.  
5. **Chat rules:** Keep behavioral instructions; remove secret tool filters only.

---

## Done when

- US-CTP1–CTP4 ACCEPT (parity + meta-tools + policy + Demo).  
- No remaining `CHAT_ALLOWED_TOOL_IDS` / `CHAT_EXCLUDED_TOOLSETS` on main.  
- Handoff doc used by Dev/Test without further PM clarification on MVP scope.
