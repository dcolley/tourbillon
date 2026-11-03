# Backlog: Harness / Direct connection (Hermes + OpenCode)

**Status:** Design note / backlog proposal
**Date:** 2026-11-02
**Context:** Product backlog #281. Design locked with Derek 2026-11-02. No wholesale replace of in-product agent runtimes; Company Computer seats are out of scope.

## Goal

Bind Tourbillon agents to external harnesses so the harness can act with the same capabilities as an in-system agent: issues, shared memory, workspace/docs, chat with board/other agents when supported, and heartbeat.

**First targets:** Hermes, then OpenCode. Other harnesses later.

## One MCP, capability-gated

Do **not** split board vs agent into separate MCP servers. One MCP/API surface. Principal = token (company/board vs agent session). Agent permissions come from normal agent config. **Before every tool call (including MCP), run the same capability gate** used for in-system agents — reject if the agent is not allowed. Creating agents only if config allows.

## Tourbillon → harness (bind)

- **Local (default):** `command` and/or local `baseUrl` (CLI or localhost API). Most harnesses are on localhost.
- **Remote (optional):** `harnessBaseUrl` + `apiToken` for a custom remote API.

## Harness → Tourbillon (`callbackUrl`)

Every heartbeat — local **and** remote — includes **`callbackUrl`** + session token so the harness phones home.

- Privacy default: callbackUrl can be `http://127.0.0.1:<tourbillon-port>/…` → 100% local traffic.
- Remote harnesses still receive a callbackUrl pointing at a private reachability path to this Tourbillon (LAN / Tailscale / controlled tunnel). Public URLs are opt-in.

## Skill install

Ship a skill-install file (Hermes SKILL.md / OpenCode skill / generic) that teaches the harness to behave as a Tourbillon agent: heartbeat loop; how to call tools via callbackUrl (issues, memory, docs/workspace, DMs); chat **if the harness supports it**.

## Chat

Capability-gated. Use sync and/or stream — whatever the harness API supports. Adapt; do not force one fixed shape.

## Proposed config fields

- `callbackUrl` (required; stamped into each heartbeat)
- session token / mint-on-start
- `skillInstall` (path or blob)
- local: `command` | `localBaseUrl`
- remote optional: `harnessBaseUrl`, `apiToken`

## First build slice

1. Docs + skill-install stubs for Hermes and OpenCode
2. Local bind + heartbeat carrying callbackUrl + session token
3. MCP tool calls through existing capability gate
4. Chat when harness advertises support (sync/stream)
5. Remote bind fields when needed

## Out of scope

- Separate Agent MCP
- Replacing in-product runtimes wholesale
- Company Computer / Kasm seats

## Done when

1. File exists at docs/backlog/harness-direct-connection.md on branch docs/281-harness-direct-connection
2. DRAFT PR open to main, title like `docs: #281 harness direct connection design note`, body Refs #281
3. Comment on https://github.com/dcolley/tourbillon/issues/281 with path + draft PR link
4. Report: SHA, PR number/URL, issue comment URL

## Implemented (Hermes slice, #281 first pack)

- **Bind storage:** `agents.adapterConfig` jsonb only — no migration, no new adapterType. A Hermes
  agent keeps `adapterType = 'harness_local'` and adds `adapterConfig.harness = "hermes"` with
  `mode: 'local' | 'remote'` (+ `command` / loopback `localBaseUrl`, or `harnessBaseUrl` +
  `apiToken`, optional `callbackBaseUrl`, `skillInstall`). Schema + validation:
  `packages/shared/src/hermes-harness.ts`. Configure via the row's jsonb until a settings-UI pack lands.
- **Heartbeat:** `packages/scheduler/src/adapters/hermes-adapter.ts` (routed from
  `wake-runner.ts`). Local CLI bind spawns `command` with the envelope on stdin +
  `TOURBILLON_WAKE_JSON` / `TOURBILLON_CALLBACK_URL` / `TOURBILLON_SESSION_TOKEN`; HTTP bind POSTs
  A2A JSONRPC `message/send` (measured Hermes gateway: agent card at `/.well-known/agent.json`,
  JSONRPC binding, `capabilities.streaming: true`, unauthenticated POST → -32050). Every envelope
  carries `callback.baseUrl` + `callback.sessionToken` (fails closed before dispatch otherwise).
  Privacy default callback: loopback (`INTERNAL_API_URL` with `localhost` → `127.0.0.1`);
  remote/private reachability via explicit `callbackBaseUrl`.
- **Callback (one surface, principal = token):** `apps/web/app/api/harness/callback/*` —
  `GET tools`, `POST tools/call`, `GET skill`, `POST chat` (501 stub). Auth = run-scoped session
  token (#110); every tool call runs through `assembleAgentTools` — the same capability gate as
  in-system agents — and denied tools are refused 403 without executing.
- **Skill install:** `HERMES_SKILL_INSTALL_MD` (shared) — shipped in the envelope and served at
  the callback `skill` endpoint.
- **OpenCode:** deliberately not implemented; shared seams (envelope types, callback gate deps)
  are harness-neutral so the second pack can reuse them.
