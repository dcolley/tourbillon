# v0.2.0 — WakeRunner + Mastra Schedules

## Breaking changes

- **BullMQ heartbeat queues removed.** Agent wakes now flow through in-process **WakeRunner** (`POST /internal/wake` on `SCHEDULER_WAKE_PORT`, default `3003`).
- **Agent timers and routines** use **Mastra Schedules**, reconciled on scheduler boot via `bootMastraSchedules()`.
- Restart **both** web and scheduler processes after upgrade.

## Database migrations

Run before starting workers:

```bash
set -a && source .env && set +a && pnpm db:migrate
```

| Migration | Change |
|---|---|
| `0008_routines_mastra_schedule_id` | `routines.mastra_schedule_id` |
| `0009_issue_plan_document` | `issues.plan_document_*` columns |
| `0010_issue_board_approval_id` | `issues.board_approval_id` |

## New environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SCHEDULER_WAKE_PORT` | Yes | `3003` | WakeRunner HTTP port |
| `SCHEDULER_WAKE_URL` | No | `http://127.0.0.1:3003` | Set if web and scheduler are on different hosts |
| `HEARTBEAT_CONTEXT_TOKEN_LIMIT` | No | `120000` | Per-step token cap (TokenLimiterProcessor) |

On Linux, set `SANDBOX_ISOLATION=bwrap` or `none` (not `seatbelt`, which is macOS-only).

## Features

- WakeRunner HTTP server for assignment, on-demand, and approval wakes
- Mastra Schedules for agent heartbeat timers and cron routines
- Issue plan documents (`putPlanDocument` tool)
- Board approval halt linkage on linked issues
- On-demand skill loading (`listSkills` / `getSkill` catalog)
- Agent heartbeat schedule form (interval + cron presets)
- `@mastra/core` 1.50.x upgrade (Schedules API); removed `@mastra__core` patch

## Upgrade checklist

1. Stop web and scheduler processes
2. Pull `v0.2.0` (or merge `main`)
3. Update `.env` with new variables above
4. `pnpm install`
5. `pnpm db:migrate`
6. `pnpm build` (production) or restart dev processes
7. Start scheduler first, then web
8. Verify Wake Now and `/jobs/heartbeat` list
