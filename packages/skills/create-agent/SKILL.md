# SKILL: Hire and Create Agents

This skill describes how to create new agent records in the company roster.

---

## §1 — When to Create an Agent

Create a new agent when:
- The org chart has a gap for a required capability
- A goal requires skills not covered by existing agents
- The board has approved a headcount increase

**Always request board approval before creating an agent** unless you are the CEO and the company policy allows autonomous hires.

---

## §2 — Agent Creation Checklist

Before calling the agents API:

- [ ] Board approval obtained (or confirmed not required by policy)
- [ ] Role is well-defined and distinct from existing agents
- [ ] Appropriate skills assigned from company skill library
- [ ] Tool tiers configured (Tier 1 auto; Tier 2 by role; Tier 3 by capability need)
- [ ] Model chosen (default: use `LM_STUDIO_DEFAULT_MODEL` env var)
- [ ] `reportsToId` set correctly in the org chart
- [ ] Budget allocated
- [ ] Heartbeat schedule configured (or left disabled for on-demand only)

---

## §3 — Skill Assignment by Role

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

## §4 — Tool Tier Assignment by Role

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

## §5 — Post-Creation Steps

After the agent record is created:
1. Verify org chart integrity (reportsTo chain is not circular)
2. Confirm `agents/{urlKey}/skills/` was seeded in the company workspace with toolset skill templates (e.g. `buffer-skills.md`). Customize per agent in the workspace as needed.
3. Add a comment to the originating issue with the new agent ID and role
4. Set the originating issue to `done`
5. If applicable, create an onboarding issue assigned to the new agent: "Introduce yourself and review your inbox"
