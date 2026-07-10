# Local development

Tourbillon is a **pnpm monorepo**. Run everything from the **repository root** (`tourbillon/`). Root `package.json` scripts are thin wrappers around workspace packages — you rarely need to `cd` into `apps/` or `packages/` for day-to-day work.

## Prerequisites

- **Node.js** 20+
- **pnpm** 9+ (`corepack enable` if needed)
- **Docker** (Postgres + Redis)
- **LM Studio** or another OpenAI-compatible API (for agent heartbeats)

## First-time setup

```bash
cd tourbillon
pnpm install
cp .env.example .env
```

Edit `.env` at the **repo root** (not inside `apps/web`). Important values:

| Variable | Purpose | Local default |
|---|---|---|
| `DATABASE_URL` | Postgres connection | `postgresql://postgres:postgres@localhost:5432/tourbillon` |
| `REDIS_URL` | Redis (SSE pub/sub) | `redis://localhost:6379` |
| `BETTER_AUTH_URL` | Auth callback base URL | `http://localhost:3002` |
| `INTERNAL_API_URL` | Scheduler → Next.js API | `http://localhost:3002` |
| `SCHEDULER_API_KEY` | Wake/schedule sync + internal issue create | `dev-scheduler-key` (match in `.env`) |
| `SCHEDULER_WAKE_PORT` | WakeRunner HTTP port | `3003` |
| `SCHEDULER_WAKE_URL` | Web → scheduler base URL | `http://127.0.0.1:3003` |
| `LM_STUDIO_BASE_URL` | LLM API endpoint | `http://localhost:1234/v1` |
| `LM_STUDIO_DEFAULT_MODEL` | Model name in LM Studio | match your loaded model |
| `COMPANY_WORKSPACE_ROOT` | Per-company shared document storage | `./data/company-workspaces` |
| `EXECUTION_WORKSPACE_ROOT` | Agent code-execution sandbox dirs | `./data/execution-workspaces` |

Relative paths for workspace roots resolve from the **monorepo root** (where `pnpm-workspace.yaml` lives), not from each process's working directory.

Start infrastructure and apply migrations:

```bash
docker compose up -d postgres redis
pnpm db:migrate
```

`db:migrate` reads `DATABASE_URL` from your shell environment. If it is unset, load `.env` first:

```bash
set -a && source .env && set +a && pnpm db:migrate
```

## What to run

### Typical dev session (three terminals, all from repo root)

**Terminal 1 — infrastructure** (once per machine reboot):

```bash
docker compose up -d postgres redis
```

**Terminal 2 — web app:**

```bash
pnpm dev
```

Opens **http://localhost:3002**. Port 3002 is intentional — Cursor and other tools often bind port 3000 on macOS.

**Terminal 3 — WakeRunner + Mastra schedules** (needed for agent wakes):

```bash
pnpm workers:dev
```

Listens on **http://127.0.0.1:3003** (`SCHEDULER_WAKE_PORT`). Web triggers assignment / Wake Now / approval wakes via `POST /internal/wake`. Timers and routines are Mastra Schedules reconciled on boot.

**Heartbeat monitor** — browse `heartbeat_runs` at **http://localhost:3002/jobs** and **http://localhost:3002/jobs/heartbeat**.

### Automatic heartbeats

On an agent detail page (`/agent/{urlKey}`), enable **Automatic heartbeats** and set an interval (minimum 60s). The scheduler upserts a Mastra schedule (`agent-timer-{agentId}`); each fire invokes WakeRunner (threadless).

**Cron routines** (optional): insert rows into the `routines` table with `enabled`, `cron_expression`, `timezone`, and `task_template` JSON. Routines appear on the agent page for enable/disable. Set `SCHEDULER_API_KEY` in `.env` so schedule fires can create issues via the internal API.

### Root scripts reference

| Command | What it runs | When you need it |
|---|---|---|
| `pnpm dev` | Next.js web app (`apps/web`) | Always, for UI and API routes |
| `pnpm workers:dev` | WakeRunner + Mastra schedules (`packages/scheduler`) | Agent wakes, timers, routines |
| `pnpm db:migrate` | Apply Drizzle migrations | After schema changes or fresh DB |
| `pnpm db:strip` | Strip dev DB to one company + default LLM provider | Local Mac reset after migrating data elsewhere |
| `pnpm db:generate` | Generate migration SQL from schema | After editing `packages/db/src/schema/` |
| `pnpm db:studio` | Drizzle Studio (DB browser) | Inspecting or seeding data |
| `pnpm build` | Production build of web app | Before deploy / smoke test |
| `pnpm type-check` | `tsc` across all packages | CI / pre-PR check |
| `pnpm lint` | ESLint across all packages | CI / pre-PR check |

### Running a single workspace package

Use `pnpm --filter <package-name> <script>` from the root:

```bash
pnpm --filter web dev
pnpm --filter @tourbillon/scheduler dev
pnpm --filter @tourbillon/db studio
```

Equivalent to the root shortcuts above. Prefer root scripts when they exist — shorter and documented in `package.json`.

## Project layout

```
apps/
  web/              Next.js 14 App Router — the only runnable app

packages/
  db/               Drizzle schema + migrations (library, no dev server)
  mastra/           Agent factory, tools, LM Studio provider (library)
  scheduler/        WakeRunner + Mastra schedules (runnable via workers:dev)
  shared/           Shared types and constants (library)
  skills/           SKILL.md files read at agent wake time (no build step)
```

**Libraries** (`db`, `mastra`, `shared`) are imported by `web` and `scheduler`. You do not start them separately — Next.js and the worker process load them via workspace links (`workspace:*` in `package.json`).

## Environment variables

- **Single source of truth:** `.env` at the repo root.
- The web app loads it via `apps/web/package.json` dev script (`source ../../.env` before `next dev`).
- Workers load it via `tsx --env-file=../../.env` in the scheduler `dev` script.
- Drizzle CLI (`db:migrate`, `db:studio`) does **not** auto-load `.env` — export variables or `source .env` before running.

## Database workflow

Schema lives in `packages/db/src/schema/`. After changing it:

```bash
set -a && source .env && set +a
pnpm db:generate    # writes SQL to packages/db/src/migrations/
pnpm db:migrate     # applies pending migrations
```

For quick local iteration without a migration file, you can use `pnpm --filter @tourbillon/db push` (Drizzle push — dev only).

Browse data:

```bash
set -a && source .env && set +a && pnpm db:studio
```

## Optional services

| Service | How to run | Used for |
|---|---|---|
| **LM Studio** | Desktop app, local server on `:1234` | Agent LLM calls |
| **SearXNG** | Uncomment in `docker-compose.yml` or set `SEARXNG_URL` | Web search MCP tool |
| **Tavily** | Set `TAVILY_API_KEY` in `.env` | Cloud web search fallback |

Heartbeats and tool calls will fail without a reachable LLM when workers process jobs.

## Troubleshooting

**Empty response on port 3000** — Something else (often Cursor) is bound to 3000. Use **http://localhost:3002**.

**`password authentication failed for user "<your-os-username>"`** — `DATABASE_URL` is not loaded. Confirm `.env` exists at the repo root and restart `pnpm dev`.

**Unstyled pages** — Ensure `apps/web/postcss.config.mjs` exists and restart the dev server.

**`/dashboard` errors after fresh clone** — Run `docker compose up -d postgres redis` then `pnpm db:migrate`.

**`Module not found: @paperclip-mastra/...`** — Stale import scope; packages should use `@tourbillon/*`.

**Port already in use** — Change the web port in `apps/web/package.json` (`next dev -p <port>`) and update `BETTER_AUTH_URL` / `INTERNAL_API_URL` in `.env` to match.

## Should I run from the root folder?

**Yes.** Always `cd` to the repo root before `pnpm install`, `pnpm dev`, `pnpm workers:dev`, or database commands. The monorepo tooling, workspace links, and environment file all assume that working directory.

## Backup and restore (filesystem data)

Tourbillon stores agent-created files outside Git under `./data/` at the repo root:

| Directory | Contents |
|---|---|
| `data/company-workspaces/` | Company documents, drafts, uploads, per-agent skills |
| `data/execution-workspaces/` | Per-issue sandbox copies from code-execution tasks |

**Back up regularly** — code restores from GitHub; filesystem data does not.

### Create a backup

```bash
./scripts/backup-workspace-data.sh ~/backups/tourbillon
```

This writes a timestamped `tourbillon-data-YYYYMMDD-HHMMSS.tar.gz` containing the entire `data/` directory. Store archives on an external drive, NAS, or cloud sync folder outside the repo.

Example cron (daily at 2am):

```cron
0 2 * * * /path/to/tourbillon/scripts/backup-workspace-data.sh /path/to/backups/tourbillon
```

### Restore after system failure

1. Clone the repo and run first-time setup (`pnpm install`, configure `.env`, `docker compose up -d`, `pnpm db:migrate`).
2. Extract your latest backup into the repo root:
   ```bash
   tar -xzf tourbillon-data-YYYYMMDD-HHMMSS.tar.gz -C /path/to/tourbillon
   ```
3. Start `pnpm dev` and `pnpm workers:dev`.

Postgres (issues, comments, agents) is separate from filesystem backups — restore the database from your own DB backup strategy if needed.

### Strip dev database (Mac)

After migrating full data to another host, shrink the local DB to one company and a default LLM provider:

```bash
docker compose up -d postgres redis
set -a && source .env && set +a
pnpm db:strip -- --dry-run   # preview keeper company and counts
pnpm db:strip                # interactive confirm
```

Adds `--yes` to skip confirm and `--wipe-workspaces` to clear the keeper company's `data/` dirs too.
