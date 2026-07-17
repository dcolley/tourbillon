# AGENTS.md — Tourbillon

> This file is for **AI coding assistants, LLM agents, and human contributors** working on the Tourbillon codebase. Read it before writing any code or making any tool calls against this repository.

---

## What Is Tourbillon?

Tourbillon is an **open-source, locally-run AI agent operating system** — a platform for running a team of autonomous agents that plan, delegate, execute, and review work through a continuous heartbeat loop. It is a TypeScript monorepo built on:

- **Next.js + React** (web app and REST API)
- **Mastra** (agent runtime, tool calling, memory, Schedules)
- **Redis** (SSE fan-out; optional legacy tooling)
- **Drizzle ORM + PostgreSQL** (persistent state)
- **LM Studio / Ollama / vLLM** (local OpenAI-compatible LLM inference — no cloud required)
- **shadcn/ui + Tailwind CSS** (component library)

The system is intentionally **fully local and open-source**. There are no mandatory cloud services. LLM calls go to LM Studio (default) or Ollama or vLLM running on the same machine.

---

## Monorepo Layout

```
tourbillon/
├── apps/
│   └── web/                   # Next.js app — UI + all REST API routes
├── packages/
│   ├── db/                    # Drizzle schema, migrations, query helpers
│   ├── mastra/                # Agent factory, tools, LM Studio provider config
│   ├── scheduler/             # WakeRunner + Mastra schedule boot (timers/routines)
│   ├── shared/                # Types, constants, logger — imported everywhere
│   └── skills/                # SKILL.md files injected into agent prompts at wake time
│       ├── control-plane/     # Core heartbeat procedure (every agent gets this)
│       ├── create-agent/      # CEO skill: how to hire a new agent
│       ├── para-memory/       # Memory discipline (what to remember vs comment)
│       └── plan-to-tasks/     # CEO/PM skill: decomposing goals into issues
├── .env.example               # All environment variables with defaults
├── docker-compose.yml         # Postgres + Redis
├── DEVELOP.md                 # Human developer setup guide
└── AGENTS.md                  # This file
```

**Libraries** (`db`, `mastra`, `shared`, `skills`) are imported by `web` and `scheduler` via workspace links — they have no dev server. Only `web` and `scheduler` are runnable.

---

## Core Concepts

### The Wake Loop

Every agent runs via a **heartbeat** driven by Tourbillon `WakeRunner` (`packages/scheduler/src/wake-runner.ts`). Triggers are HTTP (`POST /internal/wake`) or Mastra Schedules (`prepare` → WakeRunner). The sequence is:

```
Wake request received (HTTP or schedule)
  → load agent record from DB
  → check status (active?), company status, budget
  → create heartbeat_runs row
  → build wake message (reason + task context + recent comments)
  → call agent.generate() via Mastra (or AgentController Session for harness_local)
  → record token usage
  → mark run succeeded/failed
```

Agents are woken by:
1. **Assignment wake** — a new issue is assigned; web calls `enqueueHeartbeat` → scheduler WakeRunner
2. **Timer wake** — `agent.runtimeConfig.heartbeat.enabled = true`; Mastra schedule `agent-timer-{agentId}` fires → WakeRunner (threadless)
3. **Routine wake** — a `routines` row’s Mastra schedule fires → creates an issue (assignment wake) via internal API
4. **Approval wake** — human decides an approval → `enqueueApprovalWake` → WakeRunner (`approval_resolved`)
5. **On-demand** — Wake Now UI → same WakeRunner path

### The Object Hierarchy

```
Goal (outcome — CEO-owned, weeks/months)
 └─ Project (optional grouping — PM-owned, days/weeks)
     └─ Issue (executable task — worker agent, hours/days)
         └─ Issue (subtask — same or delegated agent)
```

- **Goals** are desired outcomes with acceptance criteria. Agents never "execute" a goal directly. The CEO agent reads goals and creates issues to achieve them.
- **Projects** are optional grouping containers. Not every goal needs a project.
- **Issues** are the atomic unit of work. The checkout lock, status machine, and heartbeat assignment all operate on issues.

Issue status machine: `backlog → todo → in_progress → in_review → done | blocked | cancelled`

### Agent Identity

Each agent row in the `agents` table has:
- `role` — `ceo | cto | engineer | pm | qa | designer | custom`
- `urlKey` — short slug used in URLs and wake routing (e.g. `cto`)
- `assignedSkills` — array of skill slugs available to the agent (always includes `control-plane`). Only `control-plane` is fully inlined in the system prompt; other skills appear as a catalog and are loaded via `listSkills` / `getSkill`
- `assignedToolsets` — Tier 2 boolean toolsets (e.g. `comments`, `approvals`, `roster`)
- `runtimeConfig.assignedTools` — Tier 2 granular tools (goal/project/issue management), toggled per tool
- `mcpServerIds` — Tier 3 MCP capability tools
- `adapterType` — runtime adapter (`lmstudio | ollama | harness_local | process | http`). `harness_local` uses headless Mastra AgentController (`createTourbillonController` + Session) — not the `mastracode` npm package. Wire value remains `harness_local`.
- `providerId` — FK to system-wide `llm_providers` registry (preferred); configure providers at `/settings`
- `modelId` — model identifier from the selected provider endpoint (e.g. `meta-llama/Llama-3.3-70B-Instruct`)
- `instructionsBundleSoulMd` — agent's personality/values (SOUL.md content)
- `instructionsBundleAgentsMd` — agent's knowledge of the team (AGENTS.md content, per-agent version)

### Tool Tiers

| Tier | Source | Gating |
|---|---|---|
| **Tier 1 — Control Plane** | `control-plane-tools.ts` | Every agent always gets these |
| **Tier 2 — Boolean toolsets** | `role-tools.ts` (+ workspace for `code-execution`) | Gated by `assignedToolsets` (comments, roster, approvals, web-search, web-search-tavily, nitter, buffer); `code-execution` attaches Mastra `LocalSandbox` workspace |
| **Tier 2 — Granular tools** | `assignable-tools.ts` | Gated by `runtimeConfig.assignedTools` (per-tool toggles in goal/project/issue groups) |
| **Tier 3 — MCP Tools** | `mcp-tools.ts` | Gated by `mcpServerIds` and/or `buffer` toolset (Buffer MCP); company `settings.mcpCredentials` or env `BUFFER_API_KEY` |

**Tier 1 tools (all agents):**
- `getIdentity` — agent identity, role, budget
- `getInbox` — assigned tasks (todo, in_progress, in_review, blocked)
- `checkoutIssue` — atomic lock acquisition before any work
- `getHeartbeatContext` — task state + comment cursor
- `getComments` — full or incremental comment thread
- `updateIssue` — status, comment, priority, assignee, blockers
- `createSubtask` — create delegated child issue
- `listSkills` / `getSkill` — skill catalog + on-demand full skill body (non-`control-plane`)

**Tier 2 boolean toolsets:**
- `comments` — `addComment`
- `approvals` — `createApproval`
- `roster` — `listAgents`
- `code-execution` — Mastra workspace sandbox (`mastra_workspace_execute_command`, `mastra_workspace_get_process_output`, `mastra_workspace_kill_process`, file tools). Gated via `buildCodeExecutionWorkspace()` in `execution-workspace.ts`, not `role-tools.ts`. Per-issue CWD under `EXECUTION_WORKSPACE_ROOT`. Toolset skill: `code-execution-skills.md`.
- `web-search` — `searxngSearch`, `searxngNewsSearch` via SearXNG JSON API (`SEARXNG_URL` or company settings)
- `web-search-tavily` — `webSearchTavily` via Tavily cloud API (`TAVILY_API_KEY` or company/agent key)
- `nitter` — X/Twitter search via self-hosted Nitter (`NITTER_URL`)
- `buffer` — Buffer social publishing via official MCP (`BUFFER_API_KEY` or company settings)

**Tier 2 granular tool groups** (each tool toggled individually in agent settings):

| Group | Read tools | Write tools |
|---|---|---|
| Goal management | `listGoals`, `getGoalDetail` | `createGoal`, `updateGoal` |
| Project management | `listProjects`, `getProjectDetail` | `createProject`, `updateProject` |
| Issue management | — (Tier 1 covers read) | `createIssue`, `putPlanDocument`, `requestConfirmation` |

Defaults: CEO/CTO/PM get all granular tools; engineers get goal/project read + issue write (no `createGoal` / `createProject` / `requestConfirmation` unless enabled).

### Code execution and harness runtime

Two **orthogonal** agent settings (configured on the agent detail page under **Code & execution**):

| Setting | Field | Effect |
|---|---|---|
| **Runtime** | `adapterType` (`lmstudio`/`ollama`/… vs `harness_local`) | Standard `Agent` heartbeat vs Mastra `AgentController` Session with thread resume (`harnessRunId`) |
| **Code execution** | `assignedToolsets` includes `code-execution` | Attaches `LocalSandbox` workspace; harness permission `edit`/`execute` = allow |

- **Agent + code-execution** — quick scripts/tests in a per-issue sandbox directory.
- **AgentController (`harness_local`) + code-execution** — multi-heartbeat coding; controller threads persist on the same issue via Session.
- Company workspace tools (`listWorkspaceFiles`, etc.) are separate from the execution sandbox (shared docs vs ephemeral scratch).

Env: `EXECUTION_WORKSPACE_ROOT`, `SANDBOX_ISOLATION` (`none` \| `seatbelt` \| `bwrap`), `SANDBOX_COMMAND_TIMEOUT_MS`. Per-agent overrides: `runtimeConfig.codeExecution`.

### Skills (Prompt Injections)

Skills teach methodology. At wake time:

1. **`control-plane` is always inlined** in the system prompt.
2. **All other assigned skills** are listed as a compact catalog (slug + short description). The agent calls `getSkill(slug)` to load the full body when needed.
3. Company / per-agent workspace files still resolve the same way; they are simply not all dumped into the system prompt.

| Layer | Location | Assignment | When loaded |
|---|---|---|---|
| **Bundled methodology** | `packages/skills/{slug}/SKILL.md` | Role defaults → `assignedSkills` | Catalog at wake; full body via `getSkill` (`control-plane` always inline) |
| **Company workspace** | `{companyWorkspace}/skills/{slug}.md` or `skills/{slug}/SKILL.md` | Discovered at hire → merged into `assignedSkills` | Same — workspace file wins over bundled for same slug |
| **Per-agent workspace** | `{companyWorkspace}/agents/{urlKey}/skills/*.md` | Not stored in DB — scanned each wake | Catalog / `getSkill` each wake (overrides assigned skills for same slug) |
| **Toolset skills** | `agents/{urlKey}/skills/buffer-skills.md`, `code-execution-skills.md` | Auto from `assignedToolsets` | Catalog / `getSkill` (excluded from per-agent dynamic scan duplication) |

Per-step `TokenLimiterProcessor` (`HEARTBEAT_CONTEXT_TOKEN_LIMIT`, default `120000`) prunes older tool/assistant messages when a multi-step heartbeat approaches the context ceiling.

At hire time, `createAgent()` calls `buildAssignedSkills()` — union of `ROLE_DEFAULT_SKILLS[role]` and slugs discovered in `skills/`. Role changes re-merge company skills via `updateAgentRole()`.

| Skill slug | File | Purpose |
|---|---|---|
| `control-plane` | `packages/skills/control-plane/SKILL.md` | The 9-step heartbeat procedure — **every agent** |
| `plan-to-tasks` | `packages/skills/plan-to-tasks/SKILL.md` | Goal decomposition — CEO and PM agents |
| `create-agent` | `packages/skills/create-agent/SKILL.md` | Hiring procedure — CEO agent |
| `para-memory` | `packages/skills/para-memory/SKILL.md` | Memory discipline — all agents |

**Never modify skill files as part of feature work.** Skills are agent-facing protocol documents. Changes need deliberate review.

### Memory

Mastra memory is keyed per agent × issue (thread). Memory keys are built in `packages/mastra/src/memory-keys.ts`:

- `resource` = `{companyId}:{agentId}` (widened to project/goal when semantic recall is enabled)
- `thread` = `{issueId}:{agentId}` when the heartbeat job includes `taskId` (assignment, approval with linked issue, etc.)

**Stateless inbox wakes** — timer, on-demand, and any heartbeat without `taskId` do **not** use Mastra memory. The legacy inbox thread (`{companyId}:{agentId}:inbox`) is deleted before each stateless wake so prior heartbeat transcripts are not replayed into the LLM context. Agents rely on control-plane tools (`getInbox`, `getHeartbeatContext`, `getComments`) for task state.

Memory persists across heartbeats only for assignment wakes with `taskId` (up to `lastMessages: 20`). **Task history is written to issue comments**, not memory — comments are the shared record of record that all agents can read.

### Observability

When `OBSERVABILITY_ENABLED=true`, Mastra tracing exports completed spans to the `agent_observability_events` table via a custom PostgreSQL exporter (`packages/mastra/src/observability/`). Spans are denormalized with `issue_id`, `goal_id`, `project_id`, and `agent_id` for fast filtering.

- **Human/debug only** — issue comments remain the agent thread of record; observability is not written to comments or BullMQ logs as primary storage.
- **UI** — `/observability` (global timeline) and the **Observability** tab on issue detail pages. **Model step** events contain final `output.text` and `toolCalls`; **Provider call** (`model_inference`) spans are latency-only.
- **Heartbeat runs** — `heartbeat_runs.trace_id` links a run to its Mastra trace.
- Set `OBSERVABILITY_STORE_MODEL_CHUNKS=true` to persist per-token `MODEL_CHUNK` spans including streamed reasoning text (high volume).

---

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+ (`corepack enable`)
- Docker (for Postgres and Redis)
- LM Studio (desktop app, run local server on port 1234)

### First-Time Setup

```bash
git clone https://github.com/dcolley/tourbillon.git
cd tourbillon
pnpm install
cp .env.example .env
# Edit .env — minimum: set DATABASE_URL, LM_STUDIO_DEFAULT_MODEL
docker compose up -d postgres redis
set -a && source .env && set +a
pnpm db:migrate
```

### Running Locally

Three terminals from the **repo root**:

```bash
# Terminal 1 — infrastructure (once per reboot)
docker compose up -d postgres redis

# Terminal 2 — web app + API
pnpm dev
# → http://localhost:3002

# Terminal 3 — heartbeat workers
pnpm workers:dev
```

- **Queue monitor:** http://localhost:3002/jobs
- **Bull Board:** http://localhost:3002/bullmq
- **DB browser:** `set -a && source .env && set +a && pnpm db:studio`

### Key Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Next.js app on :3002 |
| `pnpm workers:dev` | WakeRunner + Mastra schedules (timers, routines) |
| `pnpm db:migrate` | Apply pending Drizzle migrations |
| `pnpm db:generate` | Generate new migration SQL from schema changes |
| `pnpm db:studio` | Drizzle Studio DB browser |
| `pnpm build` | Production build |
| `pnpm type-check` | TypeScript check across all packages |
| `pnpm lint` | ESLint across all packages |

### Environment Variables

All variables live in `.env` at the repo root. Key ones:

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgresql://postgres:postgres@localhost:5432/tourbillon` |
| `REDIS_URL` | Redis (SSE pub/sub) | `redis://localhost:6379` |
| `LM_STUDIO_BASE_URL` | LM Studio API | `http://localhost:1234/v1` |
| `LM_STUDIO_DEFAULT_MODEL` | Default model identifier | match your loaded model |
| `LLM_PROVIDER` | Env fallback + seeds default registry entry | `lmstudio` |
| `LLM_API_MODE` | `chat` or `responses` API mode | `chat` |
| `INTERNAL_API_URL` | Scheduler → Next.js API | `http://localhost:3002` |
| `SCHEDULER_API_KEY` | Wake/schedule sync + internal issue create | `change-me-in-production` |
| `SCHEDULER_WAKE_PORT` | WakeRunner HTTP port | `3003` |
| `SCHEDULER_WAKE_URL` | Web → scheduler base URL | `http://127.0.0.1:3003` |
| `BETTER_AUTH_SECRET` | Auth signing secret | generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Auth callback base URL | `http://localhost:3002` |
| `MEMORY_SEMANTIC_RECALL` | Enable pgvector semantic memory | `false` |
| `MEMORY_EMBEDDING_MODEL` | Embedding model for semantic memory | `text-embedding-nomic-embed-text-v1.5` |
| `OBSERVABILITY_ENABLED` | Export Mastra spans to PostgreSQL | `false` |
| `OBSERVABILITY_STORE_MODEL_CHUNKS` | Persist streamed MODEL_CHUNK spans (text/reasoning); model_step has final text without this | `false` |
| `OBSERVABILITY_PREVIEW_CHARS` | Truncate span previews in list UI | `500` |
| `OBSERVABILITY_MAX_PAYLOAD_BYTES` | Cap stored span payload JSON size | `32768` |

---

## Database Schema

Schema files live in `packages/db/src/schema/`. The tables are:

| Table | Purpose |
|---|---|
| `companies` | Tenant — each company is an isolated agent workspace |
| `llm_providers` | System-wide LLM endpoint registry (type, URL, API key, headers) |
| `agents` | Agent definitions — identity, model, skills, toolsets, budget |
| `goals` | Desired outcomes owned by the CEO agent |
| `projects` | Optional grouping containers under goals |
| `issues` | Executable tasks — the atomic work unit |
| `routines` | Cron-triggered task templates per agent |
| `approvals` | Board approval requests from agents |
| `heartbeat_runs` | Audit log of every agent.generate() invocation |
| `agent_observability_events` | Denormalized Mastra span events for observability UI |
| `cost_events` | Per-run token usage records |
| `activity_log` | Human-readable event feed |
| `skills` | DB-persisted skill records (supplements file-based skills) |

### Schema Change Workflow

```bash
# 1. Edit files in packages/db/src/schema/
# 2. Generate migration SQL
set -a && source .env && set +a
pnpm db:generate

# 3. Apply migration
pnpm db:migrate

# 4. Commit both the schema change and the generated migration file
git add packages/db/src/schema/ packages/db/src/migrations/
git commit -m "db: <description of change>"
```

**Never run `pnpm db:push` in shared or production environments.** Use `db:push` only for rapid local iteration on a throw-away database.

---

## API Routes

All routes live in `apps/web/app/api/`. Key endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/agents/me` | Agent identity (called by getIdentity tool) |
| `GET` | `/api/agents/me/inbox-lite` | Compact assignment list (getInbox tool) |
| `POST` | `/api/issues/:id/checkout` | Atomic lock acquisition |
| `PATCH` | `/api/issues/:id` | Update status, comment, assignee |
| `GET` | `/api/issues/:id/comments` | Comment thread (paginated) |
| `POST` | `/api/issues/:id/comments` | Add comment |
| `GET` | `/api/issues/:id/heartbeat-context` | Task state + comment cursor |
| `GET` | `/api/companies/:id/goals` | List goals |
| `POST` | `/api/companies/:id/issues` | Create issue (also called by Mastra routine schedules) |
| `POST` | `/api/companies/:id/approvals` | Submit board approval request |

API routes authenticate the agent via a run-scoped API key in the `Authorization: Bearer` header. The key encodes `{ runId, agentId, companyId }` and is generated per heartbeat in the worker.

---

## Adding a New Feature

### New Tool

1. Create `packages/mastra/src/tools/my-tools.ts` — use `createTool` from `@mastra/core/tools`
2. Add to a toolset in `role-tools.ts` (Tier 2) or `control-plane-tools.ts` (Tier 1)
3. Add corresponding API route in `apps/web/app/api/`
4. Update the relevant SKILL.md if the tool changes agent behaviour
5. Run `pnpm type-check` before committing

### New Skill

1. **Bundled (all companies):** Create `packages/skills/my-skill/SKILL.md` — slug is the directory name.
2. **Company-wide:** Add `skills/my-skill.md` or `skills/my-skill/SKILL.md` under the company workspace — discovered at hire and merged into `assignedSkills`.
3. **Per-agent (dynamic):** Add `agents/{urlKey}/skills/my-skill.md` — injected on every wake without DB changes.
4. Skills are read from disk at wake time — no build step needed. Company workspace content overrides bundled files for the same slug.

### New Schema Table

Follow the schema change workflow above. Mirror the pattern from existing schema files — use `createId` for primary keys, reference `companies.id` with `onDelete: cascade` for tenant isolation.

### New API Route

- Routes live under `apps/web/app/api/`
- Use the shared `extractRunContext(req)` helper to get `agentId`, `companyId`, `runId` from the Bearer token
- Return `NextResponse.json(data)` — no custom response classes
- Always validate with Zod before writing to DB

---

## Code Conventions

- **TypeScript everywhere** — no `any`, use Zod schemas for runtime validation
- **pnpm workspaces** — always run commands from the repo root, never `cd` into packages
- **Drizzle for all DB access** — no raw SQL strings, use the query builder
- **No circular dependencies** — `web` and `scheduler` import from `db`, `mastra`, `shared`; never the reverse
- **shadcn/ui + Tailwind** for all UI components — no additional CSS frameworks
- **`@tourbillon/*` package scope** — all workspace packages use this prefix
- **Comments are the record of record** — agent decisions go in issue comments, not memory or files

---

## Testing

### Manual Testing Flow

1. Start infrastructure + web + workers (three terminals above)
2. Open http://localhost:3002, create a company and at least one agent
3. Set the agent's model to match what's loaded in LM Studio
4. Create a goal, then create an issue and assign it to the agent
5. On the agent detail page, click **Wake Now** — watch the heartbeat run in `/jobs`
6. Check the issue comments for the agent's output

### Automated Tests

```bash
pnpm type-check    # TypeScript — run before every PR
pnpm lint          # ESLint — run before every PR
```

Unit and integration tests are not yet implemented — contributions welcome. The recommended approach is Vitest for unit tests in each package.

---

## Governance and Approvals

Tourbillon has three distinct approval paths — do not conflate them:

| Kind | Mechanism | Behavior |
|---|---|---|
| **Issue review** | Comment + reassign (`status: in_review`, `assigneeAgentId` = reviewer) | Agent-to-agent or agent-to-human review handoff. Control-plane §2a. |
| **Board approval** | `createApproval` → `/approval` UI → decide | Linked issues are **halted** (`blocked` + `boardApprovalId`). Checkout and non-`blocked` status updates return 409 until decided. Approve restores prior status; reject clears the halt id but leaves `blocked`. Decide triggers WakeRunner `approval_resolved` (not Mastra ToolApprovals / Signals). |
| **Tool access** | Agent config (`assignedToolsets`, `assignedTools`, MCP) | Tools are granted at hire/settings time. Per-tool HITL is intentionally out of scope. |

Agents that need irreversible or high-cost actions (hiring a new agent, large spend, external integrations) must call `createApproval` with linked `issueIds`. Prefer a comment on those issues explaining why. Do **not** use `in_review` for board governance — that status is for agent review handoff.

Approval types: `request_board_approval`, `hire_agent` (extensible — add new types as needed).

---

## Planned Features (Not Yet Implemented)

These are discussed in the project's design documents and are next on the roadmap:

| Feature | Status | Notes |
|---|---|---|
| **Document workspaces** | Planned | `documents` table with `shared \| agent_private \| issue_scoped` visibility |
| **Remote executor service** | Planned | Optional `packages/executor` for network-isolated execution; today uses in-process `LocalSandbox` |
| **Routines UI** | Planned | CRUD page at `/dashboard/routines` |
| **Review step skill** | Planned | `§ Review Protocol` in control-plane SKILL.md; no schema changes needed |
| **Agents/new-hire UI** | Planned | `/dashboard/agents/new` page |
| **Semantic memory** | Optional | pgvector; enabled via `MEMORY_SEMANTIC_RECALL=true` |

---

## Common Pitfalls

**`Module not found: @paperclip-mastra/...`** — Stale import. All packages use `@tourbillon/*` scope.

**`password authentication failed for user "<os-username>"`** — `DATABASE_URL` not in environment. Run `set -a && source .env && set +a` first.

**Port 3002 not 3000** — Port 3000 is intentionally avoided (Cursor and other tools bind it). Always use http://localhost:3002.

**Workers not processing jobs** — Check that `pnpm workers:dev` is running (WakeRunner on port 3003). Assignment / Wake Now call the scheduler HTTP API; timers/routines need Mastra schedule boot on that process.

**Agent generates but does nothing useful** — Check that the model is loaded and running in LM Studio, and that `LM_STUDIO_DEFAULT_MODEL` in `.env` exactly matches the model identifier shown in LM Studio.

**409 on checkout** — Another heartbeat run holds the lock. This is expected and correct. The agent should pick a different task.

**`db:migrate` fails with "relation already exists"** — The migration was already applied. Check `drizzle.__migrations` table. If genuinely out of sync, use `pnpm db:push` locally only to force alignment.

---

## Repository

[https://github.com/dcolley/tourbillon](https://github.com/dcolley/tourbillon)
