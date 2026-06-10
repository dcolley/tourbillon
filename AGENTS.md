# AGENTS.md — Tourbillon

> This file is for **AI coding assistants, LLM agents, and human contributors** working on the Tourbillon codebase. Read it before writing any code or making any tool calls against this repository.

---

## What Is Tourbillon?

Tourbillon is an **open-source, locally-run AI agent operating system** — a platform for running a team of autonomous agents that plan, delegate, execute, and review work through a continuous heartbeat loop. It is a TypeScript monorepo built on:

- **Next.js 16 + React 19** (web app and REST API)
- **Mastra** (agent runtime, tool calling, memory)
- **BullMQ + Redis** (job scheduling and heartbeat queue)
- **Drizzle ORM + PostgreSQL** (persistent state)
- **LM Studio / Ollama** (local OpenAI-compatible LLM inference — no cloud required)
- **shadcn/ui + Tailwind CSS** (component library)

The system is intentionally **fully local and open-source**. There are no mandatory cloud services. LLM calls go to LM Studio (default) or Ollama running on the same machine.

---

## Monorepo Layout

```
tourbillon/
├── apps/
│   └── web/                   # Next.js app — UI + all REST API routes
├── packages/
│   ├── db/                    # Drizzle schema, migrations, query helpers
│   ├── mastra/                # Agent factory, tools, LM Studio provider config
│   ├── scheduler/             # BullMQ workers (heartbeat, routines, approvals)
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

Every agent runs via a **heartbeat**. A heartbeat is a single BullMQ job processed by `packages/scheduler/src/heartbeat-worker.ts`. The sequence is:

```
BullMQ job dequeued
  → load agent record from DB
  → check status (active?), company status, budget
  → create heartbeat run record
  → build wake message (reason + task context + recent comments)
  → call agent.generate() via Mastra with up to 30 tool-call steps
  → record token usage
  → mark run succeeded/failed
```

Agents are woken by three triggers:
1. **Assignment wake** — a new issue is assigned; `enqueueHeartbeat` is called from the API route
2. **Timer wake** — `agent.runtimeConfig.heartbeat.enabled = true` with an interval; `agent-interval-scheduler.ts` enqueues on the interval
3. **Routine wake** — a `routines` row fires via cron; `routine-scheduler.ts` creates an issue and that triggers an assignment wake

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
- `assignedSkills` — array of skill slugs injected into the system prompt (always includes `control-plane`)
- `assignedToolsets` — Tier 2 role-gated tools (e.g. `planning`, `approvals`, `roster`)
- `mcpServerIds` — Tier 3 MCP capability tools
- `adapterType` — `lmstudio | ollama | process | http`
- `modelId` — model identifier as loaded in LM Studio (e.g. `meta-llama/Llama-3.3-70B-Instruct`)
- `instructionsBundleSoulMd` — agent's personality/values (SOUL.md content)
- `instructionsBundleAgentsMd` — agent's knowledge of the team (AGENTS.md content, per-agent version)

### Tool Tiers

| Tier | Source | Gating |
|---|---|---|
| **Tier 1 — Control Plane** | `control-plane-tools.ts` | Every agent always gets these |
| **Tier 2 — Role Tools** | `role-tools.ts` | Gated by `assignedToolsets` array on the agent |
| **Tier 3 — MCP Tools** | `mcp-tools.ts` | Gated by `mcpServerIds` on the agent |

**Tier 1 tools (all agents):**
- `getIdentity` — agent identity, role, budget
- `getInbox` — assigned tasks (todo, in_progress, in_review, blocked)
- `checkoutIssue` — atomic lock acquisition before any work
- `getHeartbeatContext` — task state + comment cursor
- `getComments` — full or incremental comment thread
- `updateIssue` — status, comment, priority, assignee, blockers
- `listGoals` — company goals with needsAttention flag
- `getGoalDetail` — full goal context
- `createSubtask` — create delegated child issue

**Tier 2 toolsets:**
- `planning` — `createIssue`, `putPlanDocument`, `requestConfirmation`
- `approvals` — `createApproval`
- `roster` — `listAgents`
- `comments` — `addComment`

### Skills (Prompt Injections)

Skills are Markdown files in `packages/skills/`. At agent wake time, `agent-factory.ts` reads each skill file referenced in `agent.assignedSkills` and appends it to the system prompt after SOUL.md and AGENTS.md.

| Skill slug | File | Purpose |
|---|---|---|
| `control-plane` | `packages/skills/control-plane/SKILL.md` | The 9-step heartbeat procedure — **every agent** |
| `plan-to-tasks` | `packages/skills/plan-to-tasks/SKILL.md` | Goal decomposition — CEO and PM agents |
| `create-agent` | `packages/skills/create-agent/SKILL.md` | Hiring procedure — CEO agent |
| `para-memory` | `packages/skills/para-memory/SKILL.md` | Memory discipline — all agents |

**Never modify skill files as part of feature work.** Skills are agent-facing protocol documents. Changes need deliberate review.

### Memory

Mastra memory is keyed per agent × issue (thread). Memory keys are built in `packages/mastra/src/memory-keys.ts`:

- `resource` = `company:{companyId}:agent:{agentId}` (agent's working memory)
- `thread` = issue ID when working a task, or `agent:{agentId}:idle` when no task

Memory persists across heartbeats for the same issue. **Task history is written to issue comments**, not memory — comments are the shared record of record that all agents can read.

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
| `pnpm workers:dev` | BullMQ workers (heartbeat, routines, approvals) |
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
| `REDIS_URL` | BullMQ / Redis | `redis://localhost:6379` |
| `LM_STUDIO_BASE_URL` | LM Studio API | `http://localhost:1234/v1` |
| `LM_STUDIO_DEFAULT_MODEL` | Default model identifier | match your loaded model |
| `LLM_PROVIDER` | `lmstudio \| ollama \| openai-compatible` | `lmstudio` |
| `INTERNAL_API_URL` | Workers → Next.js API | `http://localhost:3002` |
| `SCHEDULER_API_KEY` | Routine scheduler auth | `change-me-in-production` |
| `BETTER_AUTH_SECRET` | Auth signing secret | generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Auth callback base URL | `http://localhost:3002` |
| `MEMORY_SEMANTIC_RECALL` | Enable pgvector semantic memory | `false` |
| `MEMORY_EMBEDDING_MODEL` | Embedding model for semantic memory | `text-embedding-nomic-embed-text-v1.5` |

---

## Database Schema

Schema files live in `packages/db/src/schema/`. The tables are:

| Table | Purpose |
|---|---|
| `companies` | Tenant — each company is an isolated agent workspace |
| `agents` | Agent definitions — identity, model, skills, toolsets, budget |
| `goals` | Desired outcomes owned by the CEO agent |
| `projects` | Optional grouping containers under goals |
| `issues` | Executable tasks — the atomic work unit |
| `routines` | Cron-triggered task templates per agent |
| `approvals` | Board approval requests from agents |
| `heartbeat_runs` | Audit log of every agent.generate() invocation |
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
| `POST` | `/api/companies/:id/issues` | Create issue (also called by routine-scheduler) |
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

1. Create `packages/skills/my-skill/SKILL.md`
2. The slug is the directory name — `my-skill`
3. Assign it to agents via `assignedSkills: ['control-plane', 'my-skill']` in the DB or UI
4. Skills are read from disk at wake time — no build step needed

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

Agents that need irreversible or high-cost actions (hiring a new agent, large spend, external integrations) must call `createApproval` and set the issue to `in_review`. This creates a pending `approvals` row. A human reviews it at `/dashboard/approvals` and approves or rejects. An approval wake worker (`approval-wake-worker.ts`) re-wakes the requesting agent when the decision is made.

Approval types: `request_board_approval`, `hire_agent` (extensible — add new types as needed).

---

## Planned Features (Not Yet Implemented)

These are discussed in the project's design documents and are next on the roadmap:

| Feature | Status | Notes |
|---|---|---|
| **Document workspaces** | Planned | `documents` table with `shared \| agent_private \| issue_scoped` visibility |
| **Code execution** | Planned | Sandboxed `packages/executor` service; `execCode` tool gated by toolset |
| **BullMQ native cron for routines** | Planned | Replace `setInterval` polling with BullMQ repeat jobs |
| **Routines UI** | Planned | CRUD page at `/dashboard/routines` |
| **Review step skill** | Planned | `§ Review Protocol` in control-plane SKILL.md; no schema changes needed |
| **Agents/new-hire UI** | Planned | `/dashboard/agents/new` page |
| **Semantic memory** | Optional | pgvector; enabled via `MEMORY_SEMANTIC_RECALL=true` |

---

## Common Pitfalls

**`Module not found: @paperclip-mastra/...`** — Stale import. All packages use `@tourbillon/*` scope.

**`password authentication failed for user "<os-username>"`** — `DATABASE_URL` not in environment. Run `set -a && source .env && set +a` first.

**Port 3002 not 3000** — Port 3000 is intentionally avoided (Cursor and other tools bind it). Always use http://localhost:3002.

**Workers not processing jobs** — Check that `pnpm workers:dev` is running. Jobs will queue in Redis but not execute without the worker process.

**Agent generates but does nothing useful** — Check that the model is loaded and running in LM Studio, and that `LM_STUDIO_DEFAULT_MODEL` in `.env` exactly matches the model identifier shown in LM Studio.

**409 on checkout** — Another heartbeat run holds the lock. This is expected and correct. The agent should pick a different task.

**`db:migrate` fails with "relation already exists"** — The migration was already applied. Check `drizzle.__migrations` table. If genuinely out of sync, use `pnpm db:push` locally only to force alignment.

---

## Repository

[https://github.com/dcolley/tourbillon](https://github.com/dcolley/tourbillon)
