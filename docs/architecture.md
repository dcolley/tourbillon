# Tourbillon Architecture

This document describes the system design and architecture of Tourbillon, an open-source AI agent orchestration platform.

## Overview

Tourbillon is a TypeScript monorepo that orchestrates teams of AI agents through a continuous heartbeat loop. The system is designed to be fully local-first with no mandatory cloud services.

## System Components

### 1. Web Application (`apps/web`)

A Next.js 14 application serving both the UI and REST API:

- **UI:** React + shadcn/ui + Tailwind CSS
- **API Routes:** `/api/*` endpoints that agents call as tools
- **Authentication:** Better Auth (API key + session)
- **Real-time:** Server-Sent Events (SSE) via Redis pub/sub

### 2. Database Layer (`packages/db`)

- **ORM:** Drizzle ORM
- **Database:** PostgreSQL with pgvector extension
- **Schema:** Tenant-isolated (company → agents → goals → projects → issues)
- **Migrations:** Versioned SQL migrations in `packages/db/src/migrations/`

Key tables:
- `companies` — Tenant isolation
- `llm_providers` — System-wide LLM endpoint registry
- `agents` — Agent definitions (identity, model, skills, toolsets, budget)
- `goals` — Desired outcomes (CEO-owned)
- `projects` — Optional grouping containers
- `issues` — Executable tasks (atomic work unit)
- `routines` — Cron-triggered task templates
- `approvals` — Board approval requests
- `heartbeat_runs` — Audit log of every agent.generate() invocation
- `agent_observability_events` — Mastra span events for observability UI
- `cost_events` — Per-run token usage records
- `activity_log` — Human-readable event feed

### 3. Agent Runtime (`packages/mastra`)

Built on Mastra.ai framework:

- **Agent Factory:** Creates Mastra Agent or AgentController instances
- **LLM Providers:** LM Studio (default), Ollama, vLLM (OpenAI-compatible)
- **Tools:** Three-tier tool system (Control Plane, Boolean Toolsets, Granular, MCP)
- **Memory:** Per-agent × issue thread memory (optional pgvector semantic recall)
- **Observability:** Mastra tracing → PostgreSQL + optional Arize Phoenix

### 4. Scheduler (`packages/scheduler`)

Heartbeat orchestration via WakeRunner + Mastra Schedules:

- **WakeRunner:** HTTP server (default :3003) that receives wake requests
- **Mastra Schedules:** Timer-based and cron-based schedule triggers
- **No BullMQ:** Heartbeats run through WakeRunner, not job queues

### 5. Shared Packages

- `packages/shared` — Types, constants, logger
- `packages/skills` — SKILL.md files (agent methodology)

## The Wake Loop

Every agent runs via a **heartbeat** driven by WakeRunner:

```
Wake request received (HTTP or Mastra Schedule)
 → Load agent record from DB
 → Check status (active?), company status, budget
 → Create heartbeat_runs row
 → Build wake message (reason + task context + recent comments)
 → Call agent.generate() via Mastra
 → Record token usage
 → Mark run succeeded/failed
```

### Wake Triggers

1. **Assignment wake** — New issue assigned; web calls `enqueueHeartbeat` → scheduler WakeRunner
2. **Timer wake** — `agent.runtimeConfig.heartbeat.enabled = true`; Mastra schedule fires → WakeRunner
3. **Routine wake** — A `routines` row's Mastra schedule fires → creates issue via internal API
4. **Approval wake** — Human decides approval → `enqueueApprovalWake` → WakeRunner
5. **On-demand** — Wake Now UI → same WakeRunner path

## Object Hierarchy

```
Goal (outcome — CEO-owned, weeks/months)
 └─ Project (optional grouping — PM-owned, days/weeks)
     └─ Issue (executable task — worker agent, hours/days)
         └─ Issue (subtask — same or delegated agent)
```

- **Goals:** Desired outcomes with acceptance criteria. Agents never execute a goal directly.
- **Projects:** Optional grouping containers. Not every goal needs a project.
- **Issues:** Atomic unit of work. Checkout lock, status machine, and heartbeat assignment operate on issues.

**Issue status machine:** `backlog → todo → in_progress → in_review → done | blocked | cancelled`

## Tool Tiers

| Tier | Source | Gating |
|---|---|---|
| **Tier 1 — Control Plane** | `control-plane-tools.ts` | Every agent always gets these |
| **Tier 2 — Boolean toolsets** | `role-tools.ts` | Gated by `assignedToolsets` |
| **Tier 2 — Granular tools** | `assignable-tools.ts` | Gated by `runtimeConfig.assignedTools` |
| **Tier 3 — MCP Tools** | `mcp-tools.ts` | Gated by `mcpServerIds` |

### Tier 1 Tools (All Agents)

- `getIdentity` — Agent identity, role, budget
- `getInbox` — Assigned tasks
- `checkoutIssue` — Atomic lock acquisition
- `getHeartbeatContext` — Task state + comment cursor
- `getComments` — Full or incremental comment thread
- `updateIssue` — Status, comment, priority, assignee, blockers
- `createSubtask` — Create delegated child issue
- `listSkills` / `getSkill` — Skill catalog + on-demand full skill body

### Tier 2 Boolean Toolsets

- `comments` — `addComment`
- `approvals` — `createApproval`
- `roster` — `listAgents`
- `code-execution` — Mastra workspace sandbox (file tools, command execution)
- `web-search` — SearXNG JSON API
- `web-search-tavily` — Tavily cloud API
- `nitter` — X/Twitter search via self-hosted Nitter
- `buffer` — Buffer social publishing via official MCP

### Tier 2 Granular Tools

Three groups (each tool toggled individually):
- **Goal management:** `listGoals`, `getGoalDetail`, `createGoal`, `updateGoal`
- **Project management:** `listProjects`, `getProjectDetail`, `createProject`, `updateProject`
- **Issue management:** `createIssue`, `putPlanDocument`, `requestConfirmation`

## Skills System

Skills teach methodology. At wake time:

1. **`control-plane` is always inlined** in the system prompt (9-step heartbeat procedure)
2. **All other assigned skills** listed as compact catalog (slug + short description)
3. Agent calls `getSkill(slug)` to load full body when needed

**Skill layers:**
- **Bundled methodology:** `packages/skills/{slug}/SKILL.md`
- **Company workspace:** `{companyWorkspace}/skills/{slug}.md`
- **Per-agent workspace:** `{companyWorkspace}/agents/{urlKey}/skills/*.md`
- **Toolset skills:** Auto from `assignedToolsets` (e.g. `code-execution-skills.md`)

Built-in skills:
- `control-plane` — Core heartbeat procedure (every agent, always on)
- `plan-to-tasks` — Goal decomposition (CEO and PM agents)
- `create-agent` — Hiring procedure (CEO agent)
- `para-memory` — Memory discipline (all agents)
- `humanizer` — Remove AI writing patterns (opt-in)

## Memory

Mastra memory is keyed per agent × issue (thread):
- `resource` = `{companyId}:{agentId}`
- `thread` = `{issueId}:{agentId}` (when heartbeat job includes `taskId`)

**Stateless inbox wakes** (timer, on-demand) do not use Mastra memory. Agents rely on control-plane tools for task state.

**Harness (`harness_local`)** always has a Session thread that persists across heartbeats.

**Task history is written to issue comments**, not memory — comments are the shared record of record.

## Code Execution

Two orthogonal agent settings:

| Setting | Field | Effect |
|---|---|---|
| **Runtime** | `adapterType` | Standard Agent vs AgentController Session |
| **Code execution** | `assignedToolsets` includes `code-execution` | Attaches Mastra `LocalSandbox` workspace |

- **Agent + code-execution:** Quick scripts/tests in per-issue sandbox directory
- **AgentController + code-execution:** Multi-heartbeat coding; controller threads persist

Workspace tools are separate from execution sandbox (shared docs vs ephemeral scratch).

## Governance and Approvals

Three distinct approval paths:

| Kind | Mechanism | Behavior |
|---|---|---|
| **Issue review** | Comment + reassign (`status: in_review`, `assigneeAgentId` = reviewer) | Agent-to-agent or agent-to-human review handoff |
| **Board approval** | `createApproval` → `/approval` UI → decide | Linked issues halted (`blocked` + `boardApprovalId`). Checkout returns 409 until decided. |
| **Tool access** | Agent config (`assignedToolsets`, `assignedTools`, MCP) | Tools granted at hire/settings time |

Approval types: `request_board_approval`, `hire_agent` (extensible)

## Observability

When `OBSERVABILITY_ENABLED=true`:
- Mastra tracing exports spans to `agent_observability_events` table
- Spans denormalized with `issue_id`, `goal_id`, `project_id`, `agent_id`
- UI at `/observability` (global timeline) and issue detail Observability tab

When `PHOENIX_COLLECTOR_ENABLED=true`:
- Same spans exported to Arize Phoenix via `@mastra/arize`
- Default endpoint: `http://localhost:6006/v1/traces`

## Data Flow

### Assignment Wake Flow

```
1. Human assigns issue to agent in UI
2. Web API: POST /api/issues/:id (assigneeAgentId)
3. Web calls enqueueHeartbeat(agentId, taskId, reason: assignment)
4. HTTP POST to SCHEDULER_WAKE_URL/internal/wake
5. Scheduler WakeRunner receives request
6. Load agent + company + issue from DB
7. Build wake message with task context
8. Call agent.generate() via Mastra
9. Agent calls control-plane tools (checkoutIssue, updateIssue, etc.)
10. Tools hit web API routes with run-scoped Bearer token
11. Record token usage, mark run complete
12. Agent comment written to issue via updateIssue
```

### Timer Wake Flow

```
1. Agent has runtimeConfig.heartbeat.enabled = true
2. Mastra schedule agent-timer-{agentId} fires (cron interval)
3. Schedule prepare() function calls WakeRunner
4. Load agent from DB (no taskId, stateless)
5. Build wake message (reason: timer)
6. Call agent.generate() via Mastra
7. Agent calls getInbox, iterates assigned issues
8. Agent picks one, calls checkoutIssue (atomic lock)
9. Agent executes work, calls updateIssue
10. Record token usage, mark run complete
```

## Environment Variables

Key configuration (all in `.env`):

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection | `postgresql://postgres:postgres@localhost:5432/tourbillon` |
| `REDIS_URL` | Redis (SSE pub/sub) | `redis://localhost:6379` |
| `LM_STUDIO_BASE_URL` | LM Studio API | `http://localhost:1234/v1` |
| `LM_STUDIO_DEFAULT_MODEL` | Default model identifier | (match loaded model) |
| `LLM_PROVIDER` | Env fallback + seeds registry | `lmstudio` |
| `LLM_API_MODE` | API mode | `chat` |
| `INTERNAL_API_URL` | Scheduler → Next.js API | `http://localhost:3002` |
| `SCHEDULER_API_KEY` | Wake/schedule auth | `change-me-in-production` |
| `SCHEDULER_WAKE_PORT` | WakeRunner HTTP port | `3003` |
| `SCHEDULER_WAKE_URL` | Web → scheduler base URL | `http://127.0.0.1:3003` |
| `MEMORY_SEMANTIC_RECALL` | Enable pgvector semantic memory | `false` |
| `OBSERVABILITY_ENABLED` | Export Mastra spans to PostgreSQL | `false` |
| `PHOENIX_COLLECTOR_ENABLED` | Export Mastra spans to Arize Phoenix | `false` |

## Security

- **Tenant isolation:** All queries filter by `companyId`
- **Run-scoped API keys:** Bearer tokens encode `{ runId, agentId, companyId }`
- **Atomic locks:** `checkoutIssue` uses DB-level locking to prevent concurrent work
- **Approval gates:** High-risk actions blocked until human approval
- **Budget ceilings:** Per-agent token budgets enforced before wake

## Deployment

Tourbillon is designed for self-hosting:

1. **Infrastructure:** Docker Compose (Postgres + Redis)
2. **Web app:** Next.js on port 3000 (`pnpm dev` or `pnpm build` + `pnpm start`)
3. **Workers:** Scheduler process (`pnpm workers:dev` or production equivalent)
4. **LLM:** LM Studio, Ollama, or vLLM running locally (OpenAI-compatible API)

No cloud services required. All data stays local.

## Extending the System

### Adding a New Tool

1. Create `packages/mastra/src/tools/my-tools.ts`
2. Add to toolset in `role-tools.ts` or `control-plane-tools.ts`
3. Add API route in `apps/web/app/api/`
4. Update relevant SKILL.md if needed

### Adding a New Skill

1. **Bundled:** Create `packages/skills/my-skill/SKILL.md`
2. **Company-wide:** Add `skills/my-skill.md` under company workspace
3. **Per-agent:** Add `agents/{urlKey}/skills/my-skill.md`

### Adding a Database Table

1. Edit `packages/db/src/schema/`
2. Run `pnpm db:generate` to create migration
3. Run `pnpm db:migrate` to apply
4. Commit both schema and migration files

## License

MIT
