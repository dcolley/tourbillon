# tourbillon

> *Tourbillon* (French, /tuʁ.bi.jɔ̃/ ['toor-bee-yon']) — literally *whirlwind* or *vortex*; from the Old French *torb(i)illon*, rooted in Latin *turbo* (a spinning top, a whirlwind).  
> In horology, the tourbillon is the most complex escapement ever invented: a self-correcting rotating cage  
> that counteracts the pull of gravity on the movement's gears, keeping time with relentless precision.  
> The name fits here — a team of agents spinning continuously through work, self-correcting as they go,  
> driven by an inner heartbeat that never stops ticking.

An open-source clone of [Paperclip AI](https://github.com/paperclipai/paperclip) built with:

- **[Mastra.ai](https://mastra.ai)** — TypeScript agent orchestration (agents, workflows, memory, MCP, Schedules)
- **[LM Studio](https://lmstudio.ai)** — local OpenAI-compatible API running open-source HuggingFace models
- **[Next.js 14](https://nextjs.org)** App Router + **[shadcn/ui](https://ui.shadcn.com)** + Tailwind CSS
- **[Drizzle ORM](https://orm.drizzle.team)** + **PostgreSQL** + pgvector
- **WakeRunner + Mastra Schedules** — timer/assignment/approval wakes (no BullMQ heartbeats)
- **[Better Auth](https://better-auth.com)** — API key + session auth

## What It Does

A control plane for running teams of AI agents as a company:

- **Org chart** — agents with roles, reporting lines, and hierarchies
- **Work system** — goals → projects → issues, with atomic checkout and state machine
- **Heartbeat loop** — agents wake on schedule or events, check their inbox, do work, exit
- **Skills** — SKILL.md files injected into agent system prompts at wake time
- **Budget tracking** — per-agent token budgets with hard ceilings
- **Governance** — approval queues with human-in-the-loop gates
- **MCP tools** — agents call the control plane API as tools

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker (for Postgres, Redis)
- [LM Studio](https://lmstudio.ai) with a model loaded and local server running on port 1234

### Setup

```bash
# Clone
git clone https://github.com/dcolley/tourbillon
cd tourbillon

# Install dependencies
pnpm install

# Copy env
cp .env.example .env
# Edit .env — set LM_STUDIO_DEFAULT_MODEL to match your loaded model

# Start infrastructure
docker compose up -d postgres redis

# Run DB migrations
pnpm db:migrate

# Start the app
pnpm dev

# In a second terminal, start the heartbeat workers
pnpm workers:dev
```

Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
apps/
  web/                  Next.js 14 App Router + shadcn/ui
packages/
  db/                   Drizzle ORM schema + migrations
  mastra/               Mastra agents, workflows, tools
  scheduler/            WakeRunner + Mastra schedule boot
  shared/               Shared types and utilities
  skills/               SKILL.md files (agent methodology)
    control-plane/
    plan-to-tasks/
    create-agent/
    para-memory/
```

## Architecture

See `[docs/architecture.md](docs/architecture.md)` for the full system design.

## License

MIT