# Backlog: Harness / Direct connection (Hermes + OpenCode)

**Status:** Design note / backlog proposal
**Date:** 2026-11-02, revised 2026-11-03 after the first Hermes slice (#316) merged.
**Context:** Product backlog #281. Design locked with Derek 2026-11-02. No wholesale replace of in-product agent runtimes; Company Computer seats are out of scope.

**Supersedes the 2026-10-08 write-up.** #281 asks to link the 2026-10-08 request for a "Harness / Direct" agent backend type (naming, run exchange, observability, skill pack, host module vs remote call) "when it lands". That write-up never landed as a standalone document; this note **supersedes** it. The aspects it named that were not covered here are now written up below: Run exchange, Observability, Topology.

## Goal

Bind Tourbillon agents to external harnesses so the harness can act with the same capabilities as an in-system agent: issues, shared memory, workspace/docs, chat with board/other agents when supported, and heartbeat.

**First targets:** Hermes, then OpenCode. Other harnesses later.

## One MCP, capability-gated

Do **not** split board vs agent into separate MCP servers. One MCP/API surface. Principal = token (company/board vs agent session). Agent permissions come from normal agent config. **Before every tool call (including MCP), run the same capability gate** used for in-system agents — reject if the agent is not allowed. Creating agents only if config allows.

**The concrete gate** is `assembleAgentTools` (`packages/mastra/src/agent-factory.ts`), driven by the agent row's tiered config in `packages/db/src/schema/agents.ts`: `assignedToolsets` (Tier 2 boolean toolsets), `runtimeConfig.assignedTools` (Tier 2 granular tools), and `mcpServerIds` (Tier 3 MCP, intersected with the company `allowedMcpServerIds` allow-list). The shipped Hermes callback surface reuses exactly this: denied tools are refused 403 without executing (`apps/web/lib/harness/callback-gate.ts`).

**Where bind config lives:** the new harness-bind fields live in **`agents.adapterConfig`** (jsonb), *not* `runtimeConfig`; this is the shipped shape from #316, chosen so no migration and no new `adapterType` enum value were needed.

## Tourbillon → harness (bind)

- **Local (default):** `command` and/or `localBaseUrl` (CLI or loopback API). Most harnesses are on localhost; `localBaseUrl` is validated loopback-only (shipped name and validation, `packages/shared/src/hermes-harness.ts`).
- **Remote (optional):** `harnessBaseUrl` + `apiToken` for a custom remote API.

## Harness → Tourbillon (`callbackUrl`)

Every heartbeat — local **and** remote — includes **`callbackUrl`** + session token so the harness phones home.

- Privacy default: callbackUrl can be `http://127.0.0.1:<tourbillon-port>/…` → 100% local traffic.
- Remote harnesses still receive a callbackUrl pointing at a private reachability path to this Tourbillon (LAN / Tailscale / controlled tunnel). Public URLs are opt-in.

## Skill install

Ship a skill-install file (Hermes SKILL.md / OpenCode skill / generic) that teaches the harness to behave as a Tourbillon agent: heartbeat loop; how to call tools via callbackUrl (issues, memory, docs/workspace, DMs); chat **if the harness supports it**.

## Chat

Capability-gated. Use sync and/or stream — whatever the harness API supports. Adapt; do not force one fixed shape.

## Run exchange

How a wake gets into the harness and how the outcome comes back.

- **Shipped (Hermes, #316):** the scheduler routes Hermes-bound agents to `dispatchHermesHeartbeat` (`packages/scheduler/src/adapters/hermes-adapter.ts`, called from `packages/scheduler/src/wake-runner.ts` instead of the in-product `AgentController`). Local bind spawns `command` with the envelope on stdin plus `TOURBILLON_WAKE_JSON` / `TOURBILLON_CALLBACK_URL` / `TOURBILLON_SESSION_TOKEN`; HTTP bind (`localBaseUrl` or `harnessBaseUrl`) POSTs A2A JSONRPC `message/send` with Bearer `apiToken`. The envelope is built by `buildHermesHeartbeatEnvelope` (`packages/shared/src/hermes-harness.ts`) and fails closed without `callback.baseUrl` + `callback.sessionToken`. A malformed bind is a terminal run failure, never a silent in-product fallback.
- **Open (proposal):** richer result exchange over the callback (token usage, truncation, finish reason) is a later pack; today the dispatch result (success / timeout / error) plus the harness's own gated issue/comment updates decide the outcome record. Retry / duplicate-wake semantics and the OpenCode run exchange are undecided.

## Observability

- **Shipped (Hermes, #316):** external Hermes runs emit no Mastra spans, so `/observability` and the issue observability tabs cover in-product runs only; the in-product span-truncation scan is skipped for Hermes runs. The `heartbeat_runs` row still records the bind (`kind: 'hermes'`, mode, `callbackBaseUrl`) and succeeded/failed.
- **Open (proposal):** whether harness-side traces are exported into the same span store (correlated via the `runId` already carried in the envelope), and usage/truncation reporting over the callback. Until then, issue comments remain the only audit trail for harness-side work.

## Topology (host module vs remote call)

- **Shipped (Hermes, #316):** dispatch lives **in-process in the scheduler** (WakeRunner → `dispatchHermesHeartbeat`); there is no separate host module today. The phone-home surface lives in the web app (`apps/web/app/api/harness/callback/*`). Local bind = same-host spawn or loopback HTTP; remote bind = outbound HTTP to `harnessBaseUrl` with Bearer `apiToken`, inbound callback over LAN / Tailscale / tunnel via explicit `callbackBaseUrl`.
- **Open (proposal):** whether the bind should move behind a host-level module/registry (shared across schedulers or reused by other products), and whether remote harnesses get a reachability-brokered callback path instead of operator-configured `callbackBaseUrl`. No decision yet; the single-scheduler in-process shape is intentional for the first slices.

## Proposed config fields

- `callbackUrl` (required; stamped into each heartbeat)
- session token / mint-on-start
- `skillInstall` (path or blob)
- local: `command` | `localBaseUrl`
- remote optional: `harnessBaseUrl`, `apiToken`

All of these live in `agents.adapterConfig` (jsonb); see "Where bind config lives" above; the shipped Hermes shape is exactly this list (`mode: 'local' | 'remote'` discriminator, optional `callbackBaseUrl` override).

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

## Done when (design acceptance)

1. An externally bound harness agent receives every heartbeat with `callbackUrl` + session token and can complete an assigned issue end-to-end through the single gated callback surface (issues, comments, memory, docs/workspace).
2. Every callback tool call passes the same capability gate as in-system agents (`assembleAgentTools`); denied tools never execute.
3. Default deployment is 100% loopback traffic; remote bind is explicit opt-in.
4. The harness behaves as a Tourbillon agent from the skill-install file alone (heartbeat loop, tools via callbackUrl).
5. Chat works when the harness advertises support (sync and/or stream).
6. OpenCode binds through the same harness-neutral seams.

Status: 1-4 are shipped for Hermes with #316 (see Implemented below); 5 (chat) shipped with Soft Pack E (see Implemented (chat, AC5) below — the 501 stub is gone for binds that advertise chat); 6 (OpenCode) shipped with the second pack (see Implemented (OpenCode slice) below).

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
  `GET tools`, `POST tools/call`, `GET skill`, `POST chat` (501 stub in this slice; shipped in Soft Pack E, AC5 below). Auth = run-scoped session
  token (#110); every tool call runs through `assembleAgentTools` — the same capability gate as
  in-system agents — and denied tools are refused 403 without executing. `tools/call` resolves
  the name against the assembled set by key (`getInboxTool`) **or** tool id (`getInbox`, the
  form the skills teach) via `findGatedTool` (S327-S1); a name not in the set stays 403.
- **Skill install:** `HERMES_SKILL_INSTALL_MD` (shared) — shipped in the envelope and served at
  the callback `skill` endpoint.
- **OpenCode:** deliberately not implemented; shared seams (envelope types, callback gate deps)
  are harness-neutral so the second pack can reuse them.

## Implemented (OpenCode slice, #281 second pack)

- **Bind storage:** same jsonb-only pattern — `adapterConfig.harness = "opencode"` with the same
  shape as the Hermes bind (`mode`, `command` / loopback `localBaseUrl`, or `harnessBaseUrl` +
  `apiToken` ≥16 chars, optional `callbackBaseUrl`, `skillInstall`; unknown keys rejected).
  Schema + validation: `packages/shared/src/opencode-harness.ts` (twin of the Hermes module).
- **Heartbeat:** `packages/scheduler/src/adapters/opencode-adapter.ts` (routed from
  `wake-runner.ts` on `harness === 'opencode'`; malformed bind fails the run loudly — never a
  silent fallback to AgentController or Hermes). Transports: local CLI bind with the same
  `TOURBILLON_WAKE_JSON` / `TOURBILLON_CALLBACK_URL` / `TOURBILLON_SESSION_TOKEN` env contract,
  or HTTP against the **measured** `opencode serve` REST surface (1.18.35: `POST /session` +
  sync `POST /session/{id}/message`; `info.finish === "stop"` is the only pass, `info.tokens`
  feeds usage; `GET /event` SSE exists — the stream leg is a follow-up). The envelope kind
  stays `tourbillon.heartbeat` v1; it rides session `metadata.tourbillon` AND a fenced JSON
  block in the prompt text (OpenCode messages have no per-message metadata). Every heartbeat
  fails closed without `callback.baseUrl` + `callback.sessionToken`. Note: `serve` gates on
  `OPENCODE_SERVER_PASSWORD` basic auth (401 + `www-authenticate: Basic` measured); remote binds
  should sit behind an operator-managed authenticating proxy validating the bind `apiToken`.
- **Callback:** unchanged shared stack (`apps/web/app/api/harness/callback/*`); the `skill`
  endpoint is harness-kind aware — OpenCode runs get the OpenCode blob
  (`OPENCODE_SKILL_INSTALL_MD`, installable as `.opencode/skill/tourbillon-agent/SKILL.md` or
  `~/.agents/skills/tourbillon-agent/SKILL.md`), Hermes runs keep theirs. Chat was 501 in this
  pack (board chat is a Tourbillon-side surface; DMs flow via `sendToAgent`); AC5 below.
- **Observability:** external OpenCode runs write no Mastra spans; the run row stamps
  `contextSnapshot.harness = { kind: 'opencode', mode, callbackBaseUrl }`.

## Implemented (chat, AC5 — Soft Pack E · S316-S3 / S322-S5)

- **Advertisement (bind):** optional `adapterConfig.chat = { sync?: boolean, stream?: boolean }`
  on both the Hermes and OpenCode binds (strict; jsonb only — no migration). Absent / all-false /
  malformed bind ⇒ nothing advertised ⇒ chat refused. Hermes HTTP binds can advertise both
  (measured agent card `capabilities.streaming: true`); OpenCode advertises `sync` (stream leg
  is only honoured when the operator sets `chat.stream`). Shared wire module:
  `packages/shared/src/harness-chat.ts`.
- **Wire:** `POST /api/harness/callback/chat` is A2A JSONRPC — `message/send` (sync; JSON-RPC
  result = A2A agent `Message`) and `message/stream` (`text/event-stream`: status-update
  `working` → `Message` → status-update `completed`/`failed` with `final: true`). The SSE is
  **buffered** (S327-S2): all frames are emitted together after the DM completes, not
  incrementally. Delivery failure (S327-S4): sync → HTTP 502 JSON-RPC error
  `chat_delivery_failed`; stream → HTTP 200 + final status-update `failed`. Recipient =
  `params.message.metadata.tourbillon.toAgentId | toAgentUrlKey` (+ optional `inReplyTo`).
- **Gate order (fail closed, nothing executes before the gate):** session token (401) → bind
  advertises chat (409 `chat_not_supported`) → JSONRPC body (400; unknown method 400
  `unsupported_method`) → requested leg advertised (409 `chat_sync_not_supported` /
  `chat_stream_not_supported`) → message text (400 `invalid_request`: empty or over
  `HARNESS_CHAT_MAX_TEXT`) → peer recipient (400 `chat_recipient_required`) →
  `assembleAgentTools` must contain the DM tool (403 `chat_not_permitted`, never executed) →
  execute that gated `sendToAgent` with the run session token as `apiKey`. Combined failures
  resolve in that order (S327-S3, pinned): an unadvertised leg is 409 even when text/recipient
  are also bad, and the 403 gate only runs once every 400 has passed. Invalid JSON is not
  answered early by the route — it reaches the gate as an empty body, so a bad token still
  gets 401 and only an authenticated caller gets the 400 (`lib/harness/callback-http.ts`).
- **No second chat stack:** delivery IS the agent's own DM tool (`/api/companies/:id/agent-mail`,
  recipient woken with `agent_mail`); Board chat stays the in-product Tourbillon chat surface
  (`/api/chat/*`), and a harness reaches the Board through issue comments / approvals.
- **Tests:** `apps/web/lib/harness/callback-chat.test.ts` (auth fail-closed, unsupported refuse,
  stream fail-closed, capability deny with execute-never sentinel, Hermes sync + stream,
  OpenCode sync), `packages/shared/src/harness-chat.test.ts` (bind schema + method map + skill
  copy). Heartbeat dispatch (Hermes/OpenCode adapters, wake-runner) is untouched.
- **Open (proposal):** a Board ⇄ harness live chat bridge (in-product chat UI relaying to the
  harness `message/stream`) would need a chat-scoped session token for tool callbacks — not in
  this pack.
