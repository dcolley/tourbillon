---
name: Tourbillon operator
description: >-
  Use this when operating a Tourbillon company (board, agents, heartbeats,
  issues, goals, projects, approvals) and you need the full product map — MCP
  covers only a slice.
---
# Tourbillon operator

Use this when operating a Tourbillon company (board, agents, heartbeats, issues, goals, projects, approvals) and MCP does not cover the action.

Tourbillon is a local-first agent orchestration app (Mastra + company board + shadcn UI). One instance hosts many companies. Operators act as the board.

## Three surfaces

| Surface | Auth | What it can do |
|---|---|---|
| Control-plane MCP `POST /api/mcp` | `X-Company-Token` | Companies, agents, heartbeat/OM knobs, failed jobs, run detail. **Not** issues/goals/projects/approvals/chat/hire. |
| REST | Split (see Auth) | Most mutations. Agent-run routes reject the company JWT. |
| Web UI | Company cookie / signed-in browser | Full product. Singular paths: `/goal` `/project` `/issue` `/approval` `/agent` `/jobs/heartbeat`. Plural `/goals` `/approvals` 404. |

Prefer MCP when the tool exists. Prefer REST with a company token when MCP lacks the tool **and** the route accepts that token. Use the UI for board decisions, issue create/cancel, goals/projects, and anything that returns 401 on the company JWT.

## Auth

1. **Company JWT** (`X-Company-Token`): mint with `POST /api/mobile/companies` body `{ "companyId": "<uuid>" }`. Header name is `X-Company-Token`, not `Authorization`. Payload `{ companyId }`. Same secret as mobile (`BETTER_AUTH_SECRET`). Token identifies the operator; `company_id` on MCP tools identifies the tenant. Isolation: `company_id` must be one `company_list` would return.
2. **Agent run token** (`Authorization: Bearer`): `validateRunToken`. Required by issue PATCH/create, many `/api/companies/:id/*` writes. Company JWT gets **401 Unauthorized** here. Do not treat that as "TEST is down".
3. **Cookie** `getActiveCompany`: web UI only. MCP must not use cookies.
4. **HITLy**: human/board gate on halted issues. Decide in-app at `/approval` (or HITLy HTTP if the company toggle is on). MCP currently cannot decide.

`GET /api/mobile/companies` lists companies with no auth (id, name, issuePrefix, slug).

## MCP tools (current)

Endpoint: `https://<host>/api/mcp`. JSON-RPC. `company_list` has no `company_id`. Every other tool requires `company_id`. Snake_case.

- `company_list` — companies this token can act as
- `list_agents` — id, name, urlKey, model, provider, active, heartbeat, OM mode
- `set_agent_active` — `agent_id`, `active`
- `set_heartbeat` — `agent_id`, `enabled`, `interval_sec` and/or `cron_expression`. Timer off = `enabled: false`
- `set_om` — `agent_id`, `mode` `inherit` | `off` | `on`, optional `provider_id` `model_id`
- `list_failed_jobs` — page, page_size
- `get_heartbeat` — `run_id`
- `list_heartbeat_events` — `run_id` (includes `errorInfo`)
- `live_heartbeat` — `run_id`

Out of MCP today (must use UI, or wait for the company-management MCP expansion): issues, goals, projects, approvals/HITLy, on-demand wake, hire, chat/DM, mail.

Consume pattern: `company_list` then pass that id on every later call.

## UI map

Sidebar (company-scoped): Dashboard, Approvals (`/approval`), Issues (`/issue`), Projects (`/project`), Goals (`/goal`), Workspace, Memory, Activity, Observability, Agents (`/agent`), Jobs (`/jobs/heartbeat`), Settings.

- **Dashboard** — agent counts, in-progress issues, pending approvals
- **Agents** `/agent` — list; `/agent/<urlKey>` tabs: config (model, heartbeat, OM, capabilities), chat, mail, memory, observability. `urlKey` can collide across companies; stay on the intended company. Wake / Run heartbeat is here. Force-kill kebab on a running heartbeat header.
- **Issues** `/issue` — filters Active / Completed / Backlog / Cancelled. Statuses: `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled`, `backlog`. Board-halted issues (`boardApprovalId`) cannot leave `blocked` until `/approval` decide. Creating an issue assigned to an agent often auto-moves it to in progress and may checkout.
- **Goals / Projects** — Active / completed / archived. Issues link to both.
- **Approvals** `/approval` — `AWAITING DECISION` and Recent Decisions. Reject/approve as the board. After reject, halted issues can be cancelled.
- **Jobs** `/jobs/heartbeat` — auto-refresh 5s/15s/30s/60s. Source Timer vs On Demand. Open `/heartbeat/<runId>` or `/jobs/heartbeat/<id>` for Overview / Logs / Observability.
- **Observability** — event types include model/tool/generic; OM observation/reflection rows are a product gap unless the OM-events PR is on the instance.
- **Settings** — company tabs (including HITLy HTTP gate, OM compaction). Per-agent OM overrides live on the agent page, not only here.
- **Memory / Workspace / Activity / Mail** — company or agent scoped. Mail is per-agent tab.

## Heartbeats and OM

- Timers: interval seconds or cron. Default display timeout field 300s; until the wall-clock abort PR is on the instance, a hung stream can run to a hard 1200s cap.
- On-demand Wake while a run is in flight is rejected ("a wake may already be in flight").
- OM observer is a second model on the same run (not a second wake). Fast combo used in ops: Spark1 + `nvidia/nemotron-3-nano-omni`. Observer often runs after the main agent (including after TokenLimiter fail), so it helps the next turn.
- TokenLimiter fail: `No messages fit within the remaining token budget`.
- Force-kill no-op on a hung generation is the same abort-path bug as the 1200s hang.

## REST that works with `X-Company-Token`

- `GET /api/mobile/companies` and `POST /api/mobile/companies`
- `GET /api/issues/list?filter=active` (rows are `{ issue, agent }`)
- `GET /api/chat/agents`
- MCP `/api/mcp`

## REST that needs an agent run token (or UI)

- `POST /api/companies/:companyId/issues`
- `PATCH /api/issues/:issueId` (status, assignee, comment)
- `POST /api/companies/:companyId/goals` and project writes
- `POST /api/approvals/:approvalId/decide`

Do not keep retrying these with the company JWT.

## Operating rules

- One company at a time. Confirm the sidebar company before mutating.
- Do not hire seats or file promote/GTM issues unless product asks.
- Do not approve HITLy/board items unless you are the board for that company. Reject stale leftover decisions; keep current-goal work.
- Do not merge app PRs or pull TEST unless the operator role says so.
- Do not clone the Tourbillon repo onto the operator machine.

## TEST reference (optional)

Public UI: `https://tourbillon-test.metaspan.com`. MCP: `https://tourbillon-test.metaspan.com/api/mcp`. Demo company slug `default`, issue prefix `TOUR`. Prefer this host over Tailscale/LAN.
