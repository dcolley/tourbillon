# Tourbillon systemd units (test server only)

User-level systemd units for the **non-Docker** Tourbillon processes on the LAN test host (`192.168.10.170`, repo at `~/tourbillon`).

Local Mac development still uses the three-terminal flow in `DEVELOP.md` (`docker compose`, `pnpm dev`, `pnpm workers:dev`).

## Services

| Unit | Command | Role |
|------|---------|------|
| `tourbillon-web.service` | `pnpm dev` | Next.js UI + API on `:3002` |
| `tourbillon-workers.service` | `pnpm workers:start` (no watch) | WakeRunner + Mastra schedules on `:3003` |

Postgres and Redis remain under Docker Compose (`docker compose up -d` in the repo root).

## Install / refresh (on the test server)

After `git pull` on `tourbillon-test`:

```bash
cd ~/tourbillon
bash scripts/systemd/install-user-units.sh
```

This copies units from `deploy/systemd/user/` into `~/.config/systemd/user/`, reloads the user systemd manager, and `enable --now` both units.

Uninstall:

```bash
bash scripts/systemd/uninstall-user-units.sh
```

Units should keep running after SSH logout (`loginctl show-user "$USER" -p Linger` → `yes`). If not: `loginctl enable-linger "$USER"`.

## Operations

```bash
systemctl --user status tourbillon-web tourbillon-workers
systemctl --user restart tourbillon-web tourbillon-workers
journalctl --user -u tourbillon-web -f
journalctl --user -u tourbillon-workers -f
```

Env vars come from the repo-root `.env` (sourced by the Next and scheduler package scripts), not from systemd `EnvironmentFile=`.

## Scheduler startup

On boot the scheduler retries Postgres with backoff for about 2 minutes, then exits non-zero if it is
still unreachable; `Restart=always` (a superset of `on-failure`) restarts it. It must run without
`tsx watch` (`workers:start`, not `workers:dev`), because watch mode keeps the process, and so the unit,
alive after the scheduler itself has died. Once ready it logs a single `scheduler ready` line, and any
run left `running` by the previous process is marked failed.

Startup details:

- Each probe uses its own single-connection client and is bounded to 10 s (handshake and query), so a
  database that accepts TCP but never answers cannot stall startup past the 2 minute budget.
- Errors that retrying cannot fix exit 1 at once instead of retrying: authentication rejected
  (`28P01`, `28000`), database does not exist (`3D000`), unknown object such as a missing role
  (`42704`), a startup parameter that cannot be set (`55P02`), or a malformed `DATABASE_URL`
  (including unencoded reserved characters such as `@`, `/` or `#` in the password). systemd then
  restarts the unit every `RestartSec`; fix `.env` and `systemctl --user restart tourbillon-workers`.
- Retry and give-up lines carry the underlying driver message and code (for example
  `ECONNREFUSED`, `28P01`), sanitised: never the connection URL or password. User, host, port and
  database name may appear.

### One scheduler per database

Run exactly **one** scheduler process against a given database. On startup the scheduler marks every
run still `running` from before its boot as failed, so a second scheduler started on the same database
(for example a local `pnpm workers:dev` pointed at the TEST database) fails the first one's in-flight
runs. Use a separate database for any extra scheduler.
