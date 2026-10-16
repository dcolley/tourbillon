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
