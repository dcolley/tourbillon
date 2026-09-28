# SKILL: Hire and Create Agents

This skill describes how to create new agent records in the company roster.

---

## §1 — When to Create an Agent

Create a new agent when:
- The org chart has a gap for a required capability
- A goal requires skills not covered by existing agents
- The board has approved a headcount increase

**Always request board approval before creating an agent** unless you are the CEO and the company policy allows autonomous hires.

Call `createApproval` with type `hire_agent`. Link any planning issue via `issueIds` so it is halted (`blocked`) until the board decides. Agent-to-agent `in_review` handoff is a different path — do not use it for board governance.

---

## §2 — Agent Creation Checklist

Before calling `createAgent`:

- [ ] Board approval obtained (or confirmed not required by policy)
- [ ] Role is well-defined and distinct from existing agents
- [ ] Tool call: `createAgent({ name, title, role, reportsToId?, runtimeType? })`

---

## §3 — Dedupe Check (When listApprovals Available)

If `listApprovals` tool is available (story #62/#63):
- Before creating agent, call `listApprovals({ type: "hire_agent", status: "approved" })`
- Check if an approval for this hire already exists and was fulfilled
- If agent already created, skip `createAgent` and comment on linked issue with existing agent ID

If `listApprovals` is not available:
- Skip dedupe check (acceptable risk of duplicate hires if approval re-runs)
- Future: implement dedupe via board approval decision tracking

---

## §4 — Tool Usage

Call `createAgent` with the following parameters:

- `name` (required): Agent display name (e.g., "Sarah Chen")
- `title` (required): Job title (e.g., "Chief Financial Officer")
- `role` (required): One of: `ceo`, `cto`, `engineer`, `pm`, `qa`, `designer`, `custom`
- `urlKey` (optional): Short slug for URLs (e.g., "cfo"). Auto-slugified from name if omitted.
- `reportsToId` (optional): Agent ID this hire reports to in the org chart
- `runtimeType` (optional): `"agent"` (default) or `"harness"` (multi-heartbeat coding)
- `instructionsBundleSoulMd` (optional): Agent personality and values (SOUL.md markdown content)
- `instructionsBundleAgentsMd` (optional): Agent team knowledge (AGENTS.md markdown content)
- `codeExecutionEnabled` (optional): Override code-execution toolset assignment (true to add, false to remove)

**Role defaults:**
- Skills, toolsets, and granular tools are assigned automatically based on role
- Default model uses company LLM provider registry
- Budget defaults to zero (unlimited); set via dashboard after hire
- Heartbeat disabled by default; enable via dashboard after hire

**Example (minimal):**
```
createAgent({
  name: "Sarah Chen",
  title: "Chief Financial Officer",
  role: "custom",
  reportsToId: "<ceo-agent-id>",
  runtimeType: "agent"
})
```

**Example (with personality and code execution):**
```
createAgent({
  name: "Sarah Chen",
  title: "Chief Financial Officer",
  role: "custom",
  reportsToId: "<ceo-agent-id>",
  instructionsBundleSoulMd: "# Soul\n\nBe methodical and detail-oriented. Always verify numbers twice.",
  instructionsBundleAgentsMd: "# Team\n\nReports to CEO. Works closely with CTO on budget planning.",
  codeExecutionEnabled: false
})
```

The tool returns the created agent record with `id`, `urlKey`, and assigned defaults.

---

## §5 — Skill Assignment by Role

| Role | Required Skills | Optional Skills |
|---|---|---|
| ceo | control-plane, plan-to-tasks, create-agent, para-memory | company-specific strategy docs |
| cto | control-plane, plan-to-tasks, para-memory | architecture docs |
| engineer | control-plane, para-memory | repo-specific context |
| pm | control-plane, plan-to-tasks, para-memory | product context |
| qa | control-plane, para-memory | test standards |
| designer | control-plane, para-memory | brand guidelines |

**Reference docs** (architecture, brand, strategy) are Lane 3 — searched on demand via MCP or web search during work. They are not indexed into issue comment history and are not stored in Mastra memory. Attach MCP servers in Tier 3 when a role needs searchable reference corpora.

---

## §6 — Tool Tier Assignment by Role

| Role | Boolean toolsets | Granular tools (`runtimeConfig.assignedTools`) | Tier 3 MCP |
|---|---|---|---|
| ceo | comments, approvals, roster, web-search | All goal/project/issue tools | — |
| cto | comments, approvals, roster | All goal/project/issue tools | github-mcp |
| engineer | comments, code-execution | `listGoals`, `getGoalDetail`, `listProjects`, `getProjectDetail`, `createIssue`, `putPlanDocument` | github-mcp, filesystem-local |
| pm | comments, approvals, roster, web-search | All goal/project/issue tools | — |
| qa | comments, code-execution | Same as engineer defaults | filesystem-local |
| designer | comments, buffer | Same as engineer defaults | — |

When the `buffer` toolset is enabled, the Buffer publishing skill (`buffer-skills.md`) auto-injects at wake time. A copy is seeded at hire time under `agents/{urlKey}/skills/` in the company workspace — customize per agent there without changing repo templates.

Granular tools are configured per-tool on the agent detail page under Capabilities. Legacy `planning` toolset maps to issue-management write tools on first save.

---

## §7 — Post-Creation Steps

After calling `createAgent`:

0. Verify tool call succeeded (no error in response)
1. Verify org chart integrity (reportsTo chain is not circular)
2. Confirm `agents/{urlKey}/skills/` was seeded in the company workspace with toolset skill templates (e.g. `buffer-skills.md`). Customize per agent in the workspace as needed.
3. Add a comment to the originating issue with the new agent ID and role
4. Set the originating issue to `done`
5. If applicable, create an onboarding issue assigned to the new agent: "Introduce yourself and review your inbox"
