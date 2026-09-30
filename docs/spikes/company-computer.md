# Company Computer Spike

**Status:** DRAFT — Option A locked (2026-09-30 Derek/PM); Test HOLD (2026-09-30 #71 @ 3d4d030)  
**Gating:** ACCEPT/HOLD draft only; HOLD per-agent VMs / bwrap-as-desktop  
**PoC Lock (2026-09-30 Derek):** One `kasmweb/desktop` container per agent on localhost Docker (TEST). Shared company files via host bind-mounts. Multi-seat / one-container-many-agents = non-goal.  
**Test Lock (2026-09-30):** Auto-provision on enable (company config `hasComputer` + allowlist image picker). `hasComputer === true` required for toolset (ban toolset OR-bypass). Board input only in takeover mode (`take_over` / `hand_back` tools + idle timeout auto-release).

---

## Executive Summary

**Company Computer** provides a durable, shared Linux desktop environment per company where Tourbillon agents can drive GUI applications (browser, file manager, shell) and the Board can watch/help in real-time. This is **option A: full desktop remote** — a single Linux host/VM per company running a lightweight desktop environment (XFCE/GNOME lite) with noVNC / Kasm / Selkies web-based access.

**Outcome:** Agents gain persistent GUI capability for tasks requiring visual interfaces (web research, admin dashboards, file browsing), while Board members can observe agent actions live and intervene when needed. The company computer complements the existing **LocalSandbox / bwrap code execution** — it does not replace it. Code execution remains per-issue ephemeral; Company Computer provides a shared, durable GUI environment.

---

## 1. Outcome

### Agent Capabilities

Agents with Company Computer access can:
- Browse the web (research, form filling, admin dashboards)
- Navigate the company filesystem via GUI file manager
- Run interactive shell sessions with persistent state
- Use visual tools (text editors, image viewers, diff tools)
- Leave work in progress across heartbeats (browser tabs, file manager state)

### Board Capabilities

Board members can:
- Watch agent desktop activity in real-time (noVNC/Selkies embed in agent detail page)
- Observe what the agent sees and clicks
- Intervene or take over when needed (shared control)
- Review desktop state after agent completes work

### Relationship to Existing Code Execution

| Feature | LocalSandbox (bwrap/seatbelt) | Company Computer |
|---|---|---|
| **Scope** | Per-issue ephemeral | Per-company durable |
| **Interface** | Shell commands only | Full GUI (browser + file manager + shell) |
| **Persistence** | Cleared between issues | Survives heartbeats and agent sessions |
| **Isolation** | Process sandbox per command | Display session per agent |
| **Use case** | Quick scripts, tests, builds | Web research, GUI tools, interactive workflows |
| **Toolset** | `code-execution` | `company-computer` (new) |

Both coexist. Agents use LocalSandbox for fast ephemeral scripting and Company Computer for GUI-required tasks.

---

## 2. Isolation Model

### PoC Container Model (Derek Lock 2026-09-30)

**One `kasmweb/desktop` container per agent** on the company Docker host (localhost TEST MVP):
- Each agent gets a dedicated container with its own desktop environment
- Containers share company files via **host bind-mounts** (`/data` and `/home` persist on TEST VM host filesystem)
- Each container exposes its own KasmVNC port (`:6901`, `:6902`, …) for Board access
- **Multi-seat / one-container-for-many-agents is a non-goal** — stock Kasmweb single-container multi-display not used

**Persistence:** Company data survives container recreate via bind-mounts:
- Host `/opt/tourbillon-company-{companyId}/data/` → container `/data/` (shared workspace, repos, documents)
- Host `/opt/tourbillon-company-{companyId}/home/{agentUrlKey}/` → container `/home/kasm-user/` (per-agent home, browser profile, config)

### Per-Agent Container Resources

Each agent container:
- Dedicated CPU/RAM via Docker resource limits (`--memory=512m --cpus=0.5`)
- Isolated desktop session (XFCE + Firefox + terminal)
- Separate browser profile under container `/home/kasm-user/.mozilla/` (backed by host bind-mount for durability)
- Unique KasmVNC listen port mapped to host

### Shared Company Filesystem

Via bind-mounts, all agent containers see:
- `/data/workspace/` — company Git repos, shared documents
- `/data/agents/{agentUrlKey}/` — per-agent work directories (visible to other agents for collaboration)
- `/data/agents/{agentUrlKey}/private/` — optional private directories (not enforced in PoC; file permissions in future)

### Board Access

Board members connect to **any agent's container** via the web UI. The live proxy targets that agent's KasmVNC port (`:6901` for first agent, `:6902` for second, etc.). Board sees exactly what that agent sees and can optionally take shared control (PoC: watch-only; control TBD).

---

## 3. MVP Path A — Recommended Stack

### Option A1: noVNC (Simplest)

**Stack:**
- `tigervnc-standalone-server` or `x11vnc` on the company VM
- `noVNC` HTML5 client (served by Tourbillon web app or standalone nginx)
- XFCE4 or GNOME lite desktop environment

**Pros:**
- Minimal dependencies (VNC server + noVNC static assets)
- Proven, mature, low memory per session
- Easy to embed in Tourbillon UI (iframe or WebSocket)

**Cons:**
- No GPU acceleration (software rendering only)
- Moderate latency for interactive web browsing
- Limited clipboard sync (requires helper daemon)

**Default for PoC/TEST (Derek Lock 2026-09-30):** `kasmweb/desktop:1.15.0` (Ubuntu 22.04 + XFCE + KasmVNC + Firefox) on localhost Docker (TEST VM). One container per agent. Company files persist via host bind-mounts (`/data`, `/home`). Rationale: proven desktop stack, persistence across container recreate, sufficient for MVP user stories (US-CC1 → CC2 → CC4).

### Option A2: Selkies (GPU-Capable)

**Stack:**
- `selkies-gstreamer` WebRTC streamer
- GStreamer with H.264 hardware encoding
- GNOME or KDE Plasma desktop environment

**Pros:**
- GPU-accelerated rendering and video encoding
- Lower latency than noVNC (WebRTC vs VNC protocol)
- Better for media-heavy tasks (YouTube playback, image editing)

**Cons:**
- Requires GPU on host (NVIDIA preferred, Intel integrated possible)
- More complex setup (GStreamer plugins, NVENC/VAAPI)
- Higher memory per session (~500MB vs ~200MB for noVNC)

**When to use:** Post-MVP if agents need GPU-heavy GUI apps (Blender, Chrome with WebGL). Not required for MVP CC1-CC4 stories.

### Option A3: Kasm (Self-Hosted SaaS Alternative)

**Stack:**
- Kasm Workspaces (self-hosted edition)
- Docker containers per session
- Built-in browser isolation and recording

**Pros:**
- Enterprise features (recording, audit logs, session sharing)
- Pre-built browser images (Chrome, Firefox) with isolation
- Native multi-tenancy (per-company workspaces)

**Cons:**
- Heavier resource usage (Docker overhead per session)
- Commercial licensing for advanced features (free tier may suffice)
- Overkill for MVP (many features unused)

**When to use:** Post-MVP if Board needs compliance features (session replay, SOC2 audit logs). Not required for thin vertical slice.

### PoC Stack (metaspan TEST)

**`kasmweb/desktop` containers (one per agent)** with KasmVNC web UI. Tourbillon web app proxies agent's KasmVNC port via authenticated iframe/embed in Computer tab. Host bind-mounts for `/data` and `/home` persistence.

---

## 4. Thin Vertical Slice — MVP-0 User Stories

### US-CC1: Provision Company Computer

**As a** Board member  
**I want** to provision a Company Computer for my company  
**So that** agents can access GUI tools

**Acceptance (PoC):**
- Board visits `/settings/company-computer` and toggles "Enable Company Computer"
- Board selects desktop image from allowlist (PoC: `kasmweb/desktop:1.15.0` default; future: version picker)
- **Auto-provision on enable:** System immediately provisions bind-mount directories on TEST VM: `/opt/tourbillon-company-{companyId}/data/` and `/opt/tourbillon-company-{companyId}/home/`
- Sets company config `hasComputer: true` in DB
- Displays company computer status: "Ready" + resource limits + selected image
- **Gating:** `hasComputer === true` required before any agent can call `company-computer` toolset tools (toolset alone cannot create homes/containers)

### US-CC2: Agent Uses Browser

**As an** agent with `company-computer` toolset enabled  
**I want** to open a browser and search the web  
**So that** I can research a task

**Acceptance:**
- Agent calls `computerOpenBrowser(url)` tool → spawns `firefox` on agent's display
- Agent calls `computerScreenshot()` → returns base64 PNG of current desktop
- Agent calls `computerClick(x, y)` → sends mouse click to agent's display
- Agent calls `computerTypeText(text)` → sends keyboard input to agent's display
- Agent can navigate browser, read rendered content via screenshots
- Browser state persists across heartbeats (tabs remain open)

### US-CC3: Agent Uses File Manager (Natural on A)

**As an** agent with `company-computer` toolset enabled  
**I want** to open a file manager GUI  
**So that** I can browse company workspace visually

**Acceptance:**
- Agent calls `computerOpenFileManager(path)` → spawns `thunar` or `nautilus` on agent's display
- Agent sees directory tree, can navigate folders via clicks
- Agent can drag/drop files (detectable via screenshots)
- File manager state persists (last visited directory remembered)

### US-CC4: Agent Uses Shell in Desktop

**As an** agent with `company-computer` toolset enabled  
**I want** to open a terminal emulator in the desktop  
**So that** I can run commands interactively

**Acceptance:**
- Agent calls `computerOpenTerminal()` → spawns `xfce4-terminal` on agent's display
- Agent can type commands, see output via screenshots
- Shell session persists (history, environment variables) across heartbeats
- Agent can run long-running processes (tail, watch) that survive heartbeat completion

### US-CC5: Board Live View (Natural on A)

**As a** Board member  
**I want** to watch an agent's desktop in real-time while chatting with the agent  
**So that** I can see what the agent is doing and collaborate

**UX Lock (Derek/PM 2026-09-30):**  
Board views Company Computer **from the Tourbillon web app while chatting to the agent**. Right-hand (or equivalent) **Computer** tab next to chat, showing that agent's GUI session (browser + file manager + shell), labeled e.g. "**\<Agent\>'s screen**". Same feel as Grok Bot Details/Media/Computer.

This is **the destination for US-CC5 / Board live-view** for option A (**live KasmVNC embed/proxy** of the agent's container desktop, not screenshot refresh). Product intent is **chat-adjacent Computer panel**, not a separate desktop-only page.

**Agent Detail Screen Layout (Derek/PM 2026-09-30):**
1. **Default after agent exists = chat** (not Overview/config). When Board navigates to an agent, they land in chat view first.
2. **Agent config** (Overview, settings, capabilities) = navigate / modal / popup off that chat default — **not the primary chrome**. Configuration is secondary to the conversation.
3. **Computer panel** = optional layouts:
   - **Hidden** — Computer tab not visible (company `hasComputer === false`, or agent lacks `company-computer` toolset, or Board closed it)
   - **Side-by-side with chat** — Computer panel alongside chat (Grok Bot–style split view; default when visible)
   - **Full screen** — Computer panel fills viewport (Board clicked "full screen" toggle; chat minimized or hidden)

**Acceptance (PoC):**
- Board chatting with agent sees **Computer** tab in right panel (alongside Details/Media/other tabs) — **only if** `hasComputer === true` and agent has `company-computer` toolset
- Tab labeled "{Agent name}'s screen" or similar
- Tab embeds **live KasmVNC iframe/proxy** connected to agent's container (Tourbillon auth proxy to `localhost:6901` etc.)
- Board sees agent's screen update in real-time (sub-second latency via WebSocket/WebRTC)
- **Watch mode by default:** Board cannot send input until clicking "Take Control" (read-only KasmVNC proxy)
- **Takeover mode:** Board clicks "Take Control" → input enabled, auto hand-back after 5min idle, Board can click "Hand Back" to release
- Computer panel is contextual — shows the agent currently being chatted with
- Computer panel supports three layout modes: hidden, side-by-side (default), full screen
- Agent config (Overview, settings) is accessible but not the default landing view

**"Done" for MVP-0:** CC1 provision → CC2 browser → CC4 shell working on Demo/TEST metaspan. CC3 file manager and CC5 Board live view are natural on option A but not strict MVP-0 blockers.

---

## 5. Session Lifecycle (PoC Container Model)

### Create Container

Triggered when an agent with `company-computer` toolset first calls a `computer*` tool:

1. **Gate:** Check company config `hasComputer === true`. If false, return error: "Company Computer not enabled. Ask Board to enable at /settings/company-computer." **Toolset alone cannot bypass this gate.**
2. Check if agent already has a container (DB: `company_computer_sessions` table with `agentId`, `containerId`, `vncPort`, `status`)
3. If no container, allocate next free KasmVNC port (`:6901`, `:6902`, …)
4. Create per-agent bind-mount directory: `/opt/tourbillon-company-{companyId}/home/{agentUrlKey}/` (company `/data/` already provisioned at US-CC1 enable)
5. Start `kasmweb/desktop` container:
   ```bash
   docker run -d \
     --name tourbillon-agent-{agentId} \
     --memory=512m --cpus=0.5 \
     -p 6901:6901 \
     -v /opt/tourbillon-company-{companyId}/data:/data \
     -v /opt/tourbillon-company-{companyId}/home/{agentUrlKey}:/home/kasm-user \
     kasmweb/desktop:1.15.0
   ```
6. Record session in DB: `{ agentId, containerId, vncPort: 6901, status: 'active', createdAt, takenOverBy: null }`
7. Return session handle to agent tool

### Resume Container

When agent calls `computer*` tool and container exists:

1. Look up session from DB by `agentId`
2. Verify container running: `docker inspect tourbillon-agent-{agentId}`
3. If stopped, restart: `docker start tourbillon-agent-{agentId}` (home dir persists via bind-mount)
4. If missing, clean up stale DB row and create new container
5. If running, return existing session handle

### Destroy Container

Triggered by Board action or agent calls `computerCloseSession()`:

1. Stop container: `docker stop tourbillon-agent-{agentId}`
2. Remove container: `docker rm tourbillon-agent-{agentId}`
3. Home directory persists on host (can recreate container later with same files)
4. Mark session `status: 'destroyed'` in DB (or delete row)

### Idle Stop (Post-MVP)

**Problem:** N idle agent containers consume RAM (200-500MB each) even when unused.

**Solution:** After 30min idle (no tool calls, no Board view), stop container:
1. `docker stop tourbillon-agent-{agentId}` (home dir persists via bind-mount)
2. Mark session `status: 'stopped'` in DB

On next tool call:
1. `docker start tourbillon-agent-{agentId}` — desktop state resumes (XFCE session, browser tabs restored from home dir)
2. Mark session `status: 'active'`

**PoC:** No auto-stop. Containers stay running until Board manually stops/removes them from `/settings/company-computer`.

### Multi-Agent Concurrency (PoC)

**One Docker host, N agent containers:**
- Container `tourbillon-agent-{ceoId}` on port `:6901` for CEO agent
- Container `tourbillon-agent-{ctoId}` on port `:6902` for CTO agent
- Container `tourbillon-agent-{engId}` on port `:6903` for engineer agent

Each container is isolated (separate filesystem namespace, network, desktop session). Agents see shared `/data/` but cannot see each other's screens. Each has private `/home/kasm-user/` (backed by separate host bind-mount).

**Concurrency limit (PoC):** Start with N=5 max containers per company (TEST VM resource limit: 16GB RAM / 8 vCPU). After 5 agents have active containers, 6th agent tool call returns error: "Company Computer capacity exceeded. Ask Board to stop idle containers."

---

## 6. Ops Risks — Required Mitigation Plan (PoC)

### Risk 1: RAM Pressure from N Desktop Containers

**Scenario (PoC):** 5 agents × 512MB per container = 2.5GB RAM for desktops, plus browser tabs inside containers.

**Mitigation (PoC):**
- **Docker memory limits:** Each container started with `--memory=512m --memory-swap=768m`. Docker kills container if exceeded; agent tool returns error.
- **Swap:** Configure 4GB zram swap on TEST VM to handle burst usage.
- **Board visibility:** `/settings/company-computer` dashboard shows per-container RAM usage (`docker stats`). Board can stop/remove idle containers.

### Risk 2: CPU Saturation from Browser Rendering

**Scenario (PoC):** Agent opens 20 tabs with auto-play videos → 100% CPU → other containers starved.

**Mitigation (PoC):**
- **Docker CPU limits:** Each container started with `--cpus=0.5` (50% of one core max). Agent cannot monopolize TEST VM CPU.
- **Browser config:** Pre-configure Firefox in Kasmweb image with `media.autoplay.enabled = false` (reduce CPU usage).
- **Watchdog (post-PoC):** If container uses >80% allocated CPU for >5min, stop container and notify Board.

### Risk 3: Idle Containers Never Reclaimed

**Scenario (PoC):** Agent finishes task, never calls `computerCloseSession()`, container stays running forever.

**Mitigation (PoC):**
- **Container GC (post-PoC):** Nightly cron scans DB for containers with `lastActivityAt > 7 days ago` and no open issues. Auto-stop those containers; post activity log entry.
- **Board override:** Board can manually stop/remove any container from `/settings/company-computer` regardless of idle time.
- **Agent reminder:** Control-plane SKILL.md updated with "If you opened a Company Computer session and finished work, call `computerCloseSession()` to release resources."

### Risk 4: Disk Growth from Browser Profiles

**Scenario (PoC):** Each agent's Firefox profile under `/opt/tourbillon-company-{companyId}/home/{agentUrlKey}/.mozilla/` grows to 2GB (cache, history, downloads).

**Mitigation (PoC):**
- **Disk quotas (post-PoC):** XFS project quotas per agent home dir. For PoC, manual Board monitoring.
- **Profile cleanup:** Firefox configured in Kasmweb image with reduced cache limits.
- **GC task (post-PoC):** Weekly cleanup deletes old downloads and caches from bind-mounted home dirs.

### Risk 5: Docker Port Exhaustion

**Scenario (PoC):** Docker port range exhausted after many container creates/destroys.

**Mitigation (PoC):**
- **Port reuse:** When removing container, mark its KasmVNC port (`:6901`, etc.) as free in DB. Next container create reuses lowest free port.
- **Port range:** Reserve `:6901` to `:6910` for agent containers (10 slots max; PoC limit is 5 concurrent).

### Concrete Plan for metaspan TEST (PoC)

**Host:** Ubuntu 22.04 VM with 16GB RAM, 8 vCPU, 100GB disk, Docker 24+.

**Docker resource limits:**
```bash
docker run -d \
  --name tourbillon-agent-{agentId} \
  --memory=512m --memory-swap=768m \
  --cpus=0.5 \
  --restart=unless-stopped \
  -p {vncPort}:6901 \
  -v /opt/tourbillon-company-{companyId}/data:/data \
  -v /opt/tourbillon-company-{companyId}/home/{agentUrlKey}:/home/kasm-user \
  kasmweb/desktop:1.15.0
```

**Bind-mount persistence:**
- `/opt/tourbillon-company-{companyId}/data/` — shared workspace (rwx for all agent containers)
- `/opt/tourbillon-company-{companyId}/home/{agentUrlKey}/` — per-agent home (rwx for that container only)

**Monitoring (post-PoC):**
- `docker stats` → Prometheus exporter → Grafana dashboard
- Per-container RAM/CPU usage, total company usage
- Alert if total RAM >12GB or any container >400MB sustained 10min

---

## 7. Egress

Company Computer inherits company-scoped egress policy (`settings.egressPolicy`):
- `allowAll: true` → no restrictions (MVP default)
- `allowedDomains: [...]` → iptables rules block Firefox from non-allowed domains (post-MVP)

**Note only:** No per-tool HITL (human-in-the-loop) approval for `computerOpenBrowser(url)`. Egress control is at company level, not per-agent-tool level. Follows existing Tourbillon egress patterns (see `web-search` and `web-search-tavily` toolsets).

**Implementation (post-MVP):**
- Use `iptables` or `nftables` to whitelist domains per company cgroup
- DNS-based filtering via local `dnsmasq` instance per company (only resolve allowed domains)
- Browser proxy auto-config (PAC file) injected into Firefox profile

**MVP-0:** No egress enforcement. Board assumes TEST environment is network-isolated or accepts open internet access.

---

## 8. Board Live View (PoC)

### UI Integration

**UX Lock (Derek/PM 2026-09-30):**  
Board views Company Computer **from the Tourbillon web app while chatting to the agent**. Right-hand (or equivalent) **Computer** tab next to chat (alongside Details/Media/other tabs), showing that agent's GUI session (browser + file manager + shell), labeled e.g. "**{Agent name}'s screen**". Same feel as Grok Bot Details/Media/Computer. This is the **chat-adjacent Computer panel** for option A (**live KasmVNC proxy/embed**, not screenshot refresh).

**Agent Detail Screen Defaults (Derek/PM 2026-09-30):**
1. **Default view = chat** — When Board navigates to an agent, they land in chat view first (not Overview/config)
2. **Agent config is secondary** — Overview, settings, capabilities accessible via navigate/modal/popup off chat default (not primary chrome)
3. **Computer panel layout options:**
   - **Hidden** — No Computer tab visible (company `hasComputer === false`, or agent lacks `company-computer` toolset, or Board manually closed it)
   - **Side-by-side with chat** (default when visible) — Computer panel in right area alongside chat (Grok Bot–style split; both visible)
   - **Full screen** — Computer panel fills viewport (Board toggled full screen; chat minimized/hidden)

**Location:** **Computer** tab in right panel when chatting with agent (contextual to current agent conversation)

**NOT:** Separate standalone page at `/agent/{urlKey}/computer`. The Computer view is embedded in the chat UI, not a separate navigation destination.

**Label:** "{Agent name}'s screen" or "{Agent urlKey}'s desktop" — makes it clear whose GUI session is being viewed.

**PoC Embed:** Tourbillon auth proxy to agent's KasmVNC port, embedded as iframe or direct WebSocket:

```html
<!-- PoC example: authenticated proxy to localhost KasmVNC -->
<div id="computer-panel" class="chat-adjacent-tab">
  <h3>CEO's screen</h3>
  <iframe 
    src="/internal/company-computer/agent/{agentId}/vnc" 
    width="100%" 
    height="100%">
  </iframe>
</div>
```

**Tourbillon auth proxy (PoC):** `apps/web` proxies `/internal/company-computer/agent/{agentId}/vnc` to `http://localhost:{vncPort}/` (KasmVNC web UI on TEST VM). Uses existing Better Auth session for authorization (Board member must be logged in and belong to the company). Route looks up agent's `vncPort` from DB (`company_computer_sessions` table), validates Board access, proxies to container.

**Product Lock:** Live proxy/embed of KasmVNC for PoC. No screenshot refresh fallback — full live-stream is the PoC implementation path.

### Watch vs Take Control (Test Lock 2026-09-30)

**Watch mode (default):**
- Board sees agent's screen in real-time via KasmVNC iframe
- **Board cannot send input** — KasmVNC proxy enforces read-only mode (pointer hidden, keyboard/mouse events dropped)
- Agent unaware Board is watching (no notification in PoC; post-PoC feature)

**Take Control mode (explicit handoff):**
- Board clicks **"Take Control"** button in Computer tab
- Agent tools call `take_over()` returns session lock (or Board UI calls internal API)
- KasmVNC proxy switches to input-enabled mode for Board
- DB: `company_computer_sessions.takenOverBy = {boardUserId}` + `takenOverAt` timestamp
- Agent desktop shows notification: "Board member {name} is now controlling this session" (post-PoC; PoC may skip)
- **Idle timeout:** If no Board input for 5min, auto-call `hand_back()` → switch back to watch mode + soft warning to Board: "Control released due to inactivity"
- Board clicks **"Hand Back"** button (or agent calls `hand_back()`) → back to watch mode, clear `takenOverBy`

**PoC Risk:** If Board input defaults to enabled without takeover gating, or if no idle timeout, sessions can hang with Board "ghost control" forever. Must implement:
1. Watch mode = read-only by default (KasmVNC proxy enforces)
2. Takeover = explicit Board action + DB session lock
3. Idle timeout → auto hand back + soft warning

**Agent Tools (added to computer toolset):**
- `take_over()` — Agent explicitly requests Board to take control (e.g. "Board, please help with this form")
- `hand_back()` — Agent reclaims control from Board (e.g. "Thanks, I'll continue from here")

**Board UI:**
- "Take Control" button (visible when `takenOverBy === null`)
- "Hand Back" button (visible when `takenOverBy === currentUserId`)
- Idle timer display: "Control will release in 3:42" (countdown from last input)

---

## 9. Agent Tools — New Tourbillon Toolset

**Toolset name:** `company-computer`

**Gating:** 
1. `assignedToolsets` includes `company-computer` (opt-in per agent, like `code-execution`)
2. **Company config `hasComputer === true` required** — toolset alone cannot create homes/containers. All tools return error if `hasComputer === false`: "Company Computer not enabled. Ask Board to enable at /settings/company-computer."

**Tools** (Tier 2 boolean toolset):

| Tool | Parameters | Returns | Description |
|---|---|---|---|
| `computerOpenBrowser` | `url?: string` | `{ sessionId, containerId, vncPort }` | Open Firefox on agent's container desktop. If `url` provided, navigate to it. If container doesn't exist, create it (gated by `hasComputer`). |
| `computerOpenFileManager` | `path?: string` | `{ sessionId, containerId, vncPort }` | Open file manager (Thunar) on agent's container desktop. If `path` provided, navigate to it. |
| `computerOpenTerminal` | `cwd?: string` | `{ sessionId, containerId, vncPort }` | Open terminal emulator (xfce4-terminal) on agent's container desktop. If `cwd` provided, set working directory. |
| `computerScreenshot` | — | `{ imageBase64: string, width, height }` | Capture current desktop as PNG via KasmVNC API. Returns base64-encoded image. Agent can analyze with vision model or save to issue comment. |
| `computerClick` | `x: number, y: number, button?: 'left'\|'right'\|'middle'` | `{ success: boolean }` | Send mouse click to (x, y) on agent's container desktop. Coordinates are absolute pixels (0,0 = top-left). Via KasmVNC API or X11 automation. |
| `computerTypeText` | `text: string` | `{ success: boolean }` | Send keyboard input to agent's container desktop (focused window receives text). Via KasmVNC API or X11 automation. |
| `computerPressKey` | `key: string, modifiers?: string[]` | `{ success: boolean }` | Send special key (e.g. `Enter`, `Tab`, `Escape`) with optional modifiers (`Ctrl`, `Shift`, `Alt`). Via KasmVNC API. |
| `computerMouseMove` | `x: number, y: number` | `{ success: boolean }` | Move mouse to (x, y) without clicking. Via KasmVNC API. |
| `computerScroll` | `direction: 'up'\|'down', amount?: number` | `{ success: boolean }` | Scroll focused window. `amount` is scroll wheel ticks (default 3). Via X11 automation inside container. |
| `computerCloseSession` | — | `{ success: boolean }` | Stop/remove agent's container. Home dir persists on host for next session. Frees RAM/CPU. |
| `computerGetSessionInfo` | — | `{ sessionId, containerId, vncPort, active, createdAt, lastActivityAt, ramMB, cpuPercent, takenOverBy }` | Get current container status and resource usage (via `docker inspect` / `docker stats`). Includes Board takeover state. |
| `take_over` | — | `{ success: boolean, message: string }` | Agent explicitly requests Board to take control. Sets flag for Board UI to show "Agent requests help" notification. Does not grant control — Board must still click "Take Control". |
| `hand_back` | — | `{ success: boolean }` | Agent reclaims control from Board. Clears `takenOverBy`, switches Board iframe back to watch mode. Returns error if Board not currently in control. |

**Tool pattern:** Mirrors Cursor `computerUse` pattern (screenshot + input) but operates over Docker container desktop (KasmVNC), not local host. These are **Tourbillon-internal tools** — not Cursor-specific tooling.

**API routes (PoC):** All tools hit new routes under `/api/internal/company-computer/*`. Routes authenticate via run-scoped Bearer token (same as existing control-plane tools). Route implementations call Docker CLI / KasmVNC API. Post-PoC: refactor to `packages/company-computer/` library.

**Skill file:** `packages/mastra/src/skills/company-computer-skills.md` teaches agents when to use GUI vs shell, screenshot frequency, resource cleanup.

---

## 10. Non-Goals

### Not in MVP-0

- **Per-agent VMs:** PoC uses one Docker host (TEST VM) with N containers (one per agent), not separate VMs per agent. Per-agent VMs may be post-MVP for high-security companies (too expensive for PoC).
- **Multi-seat / one-container-many-agents (Derek Lock 2026-09-30):** Stock Kasmweb single-container multi-display is a **non-goal**. PoC runs **one `kasmweb/desktop` container per agent** on the company Docker host with per-agent KasmVNC ports.
- **Bwrap-as-desktop:** Do not repurpose LocalSandbox bwrap for GUI isolation. Bwrap is for ephemeral process sandboxing; Company Computer is for durable GUI sessions. Architecture mismatch.
- **Managed desktop SaaS:** Do not bind to third-party SaaS (Windows 365, Amazon WorkSpaces, etc.) in PoC. Self-hosted Docker containers only. SaaS may be post-MVP for compliance-heavy customers.
- **Separate desktop-only page:** Computer view is **not** a standalone page at `/agent/{urlKey}/computer`. It is a **chat-adjacent tab** (right panel) visible while chatting with the agent. Product intent: Board watches agent's screen in the same UI where they chat, not a separate navigation destination.
- **TEST auto-deploy:** This spike/PR does **not** enable Company Computer on tourbillon-test.example.com. No runtime changes that pull to TEST without explicit Derek approval. This is docs-only.
- **Session recording:** No built-in session replay in PoC. Board can manually screen-record via browser if needed. Audit logs are post-MVP compliance feature.
- **GPU acceleration:** No GPU passthrough in PoC. Kasmweb software rendering sufficient for CC1-CC4 stories. GPU is post-MVP for media-heavy tasks.
- **Mobile Board view:** KasmVNC embed works on desktop only. Mobile browser support is post-MVP (touch → mouse translation is poor UX without native app).

---

## 11. Open Questions for Ops/Derek

### Q1: VM Image Choice

**Question:** Which base image for company VMs — Ubuntu 22.04 Server + XFCE, or custom golden image with pre-installed Firefox/tooling?

**Options:**
- **A)** Standard Ubuntu 22.04 + shell script to install XFCE/VNC on first boot (slow first provision, ~2min)
- **B)** Custom AMI/image with XFCE + VNC + Firefox pre-installed (fast provision, <10sec, but requires image maintenance)

**Recommendation:** Start with A for MVP (fewer moving parts), move to B post-MVP when provisioning speed matters.

### Q2: GPU Passthrough

**Question:** Do we need GPU passthrough for any MVP story (CC1-CC4)?

**Answer (draft):** No. noVNC software rendering sufficient for browser + file manager + terminal. GPU needed only for:
- WebGL-heavy web apps (3D visualizations)
- Video encoding (agent records demo videos)
- Image editing (GIMP, Blender)

None of these are MVP. Defer GPU until post-MVP.

### Q3: Tailscale Exposure of VNC

**Question:** Should Board be able to connect to agent VNC directly via Tailscale, bypassing Tourbillon web app proxy?

**Use case:** Board uses native VNC client (better performance than noVNC) to connect to `company-vm.tailnet:5910`.

**Tradeoff:**
- **Pro:** Lower latency, native client features (clipboard sync, full-screen)
- **Con:** Bypasses Tourbillon auth (Board must know VNC port numbers; no audit log of who watched which agent)

**Recommendation:** MVP uses web app proxy only (audit trail, auth). Direct Tailscale VNC is post-MVP power-user feature gated behind company setting.

### Q4: Idle Hibernate Trigger

**Question:** Should idle hibernate be time-based (30min idle) or resource-based (when total company RAM >80%)?

**Options:**
- **A)** Time-based: Hibernate after 30min idle regardless of RAM pressure
- **B)** Resource-based: Only hibernate when RAM pressure high (>12GB used on 16GB host)

**Recommendation:** Start with neither (no hibernate in MVP). Post-MVP, use B (resource-based) — only reclaim when needed, avoid unnecessary session disruption.

### Q5: Multi-Company Isolation on Shared TEST Host

**Question:** Can multiple companies share one metaspan TEST host, or does each company need dedicated VM?

**Security concern:** Company A agent could theoretically attach to company B's display socket via filesystem tricks.

**Mitigation:**
- **A)** One VM per company (cleanest isolation, higher cost)
- **B)** Shared VM + strict file permissions (`/tmp/.X11-unix/X10` owned by `agent-companyA-ceo` user, mode 0600)
- **C)** Shared VM + separate network namespaces (each company in isolated netns, VNC ports not routable between companies)

**Recommendation:** MVP uses A (one VM per company on TEST). Shared VM is post-MVP optimization for high-density hosting.

---

## 12. Next Steps

### Phase 1: Spike Review (This PR)

- [ ] Derek/PM reviews this spike doc
- [ ] Ops reviews Risks §6 and Open Questions §11
- [ ] Board/agent team reviews user stories §4
- [ ] Lock MVP scope: CC1 provision → CC2 browser → CC4 shell only

### Phase 2: Proof-of-Concept (Separate Branch)

- [ ] Provision bind-mount directories on TEST VM: `/opt/tourbillon-company-{companyId}/data/` and `/opt/tourbillon-company-{companyId}/home/`
- [ ] Pull `kasmweb/desktop:1.15.0` image
- [ ] Implement `computerOpenBrowser` + `computerScreenshot` tools (Docker + KasmVNC API)
- [ ] Test: Agent calls `computerOpenBrowser('https://example.com')`, takes screenshot, includes in issue comment
- [ ] Validate Docker resource limits work (manually stress-test with 3 concurrent agent containers)

### Phase 3: PoC Implementation (POST This PR)

- [ ] New package (post-PoC): `packages/company-computer/` (container manager, KasmVNC proxy)
- [ ] DB migrations:
  - [ ] `companies` table: add `hasComputer: boolean` (default `false`), `computerImageTag: string` (e.g. `kasmweb/desktop:1.15.0`)
  - [ ] `company_computer_sessions` table: `agentId`, `containerId`, `vncPort`, `status`, `takenOverBy: userId | null`, `takenOverAt: timestamp | null`, `lastBoardInputAt: timestamp | null`, `createdAt`, `lastActivityAt`
- [ ] New toolset: `company-computer` in `role-tools.ts` (includes `take_over` / `hand_back` tools)
- [ ] API routes: `/api/internal/company-computer/*` (container CRUD, screenshot, input automation, takeover state management)
- [ ] Skill file: `company-computer-skills.md`
- [ ] UI: **Computer** tab (chat-adjacent) with KasmVNC iframe/proxy embed (read-only by default, "Take Control" button for input)
- [ ] UI: `/settings/company-computer` dashboard:
  - [ ] Enable toggle + allowlist image picker (auto-provisions bind-mounts on enable)
  - [ ] Container list + resource usage via `docker stats`
  - [ ] Per-container stop/remove actions
- [ ] KasmVNC proxy: read-only mode enforcement, takeover switching, idle timeout (5min → auto hand-back)
- [ ] Ops: Docker Compose / systemd units for TEST VM container orchestration
- [ ] Docs: Update AGENTS.md with Company Computer toolset and architecture

### Phase 4: TEST Validation (HOLD Until Derek Approval)

- [ ] Deploy to tourbillon-test.example.com
- [ ] Create test company "Demo Corp"
- [ ] Board enables Company Computer at `/settings/company-computer` (auto-provisions bind-mounts: `/opt/tourbillon-company-democorp/data/` and `/opt/tourbillon-company-democorp/home/`)
- [ ] Verify `companies.hasComputer === true` in DB
- [ ] Create test agent "TestBot" with `company-computer` toolset
- [ ] Assign issue: "Research Tourbillon competitors via Google"
- [ ] TestBot calls `computerOpenBrowser`, searches, screenshots results, posts to issue
- [ ] Board watches TestBot's desktop via live KasmVNC proxy embed (watch mode: read-only, no Board input)
- [ ] Board clicks "Take Control" → input enabled, Board helps TestBot, clicks "Hand Back" after done
- [ ] Verify idle timeout: Board takes control, waits 5min without input → auto hand-back + soft warning
- [ ] Validate Docker resource limits (create 5 agents with `company-computer` toolset, stress-test RAM/CPU per container)
- [ ] Verify toolset gate: try calling `computerOpenBrowser` from agent in company with `hasComputer === false` → returns error

---

## Appendix A: Rejected Options (B, C, D)

### Option B: Per-Agent VMs

**Why rejected (PoC):** Too expensive. N agents × 1GB RAM per VM = unsustainable for companies with 10+ agents. Overkill isolation (agents are cooperative, not adversarial). Provisioning time too slow (30sec per VM vs 2sec per container).

**When to revisit:** Post-MVP for enterprise customers requiring strict agent isolation (financial services, healthcare). Gated behind company setting `isolationMode: perAgentVM`.

**PoC uses Docker containers instead:** One `kasmweb/desktop` container per agent. Lighter weight, faster provisioning, sufficient isolation for cooperative agents.

### Option C: Managed Desktop SaaS (Windows 365 / WorkSpaces)

**Why rejected:** External dependency violates Tourbillon's local-first principle. Monthly per-seat cost adds up. SaaS vendors do not expose per-session cgroup controls (can't enforce RAM caps). Windows licensing complexity.

**When to revisit:** Post-MVP if customer explicitly requires Windows GUI tools (Excel macros, Outlook). Tourbillon can integrate as optional backend, not default.

### Option D: Bwrap-as-Desktop

**Why rejected (HOLD):** Architectural mismatch. Bwrap is for ephemeral process isolation (run script → exit). Company Computer needs durable GUI sessions (survive heartbeats, persist state). Bwrap cannot isolate X11 displays (all processes in bwrap share same `DISPLAY`). No window manager support (bwrap is CLI-only sandbox).

**Confusion risk:** Developers might try to "upgrade" bwrap to support GUI, bloating LocalSandbox codebase with unrelated features. Keep concerns separate: LocalSandbox = ephemeral code execution; Company Computer = durable GUI environment.

**PoC Lock (Derek 2026-09-30):** HOLD bwrap-as-desktop. PoC uses Docker containers with KasmVNC instead.

---

## Appendix B: Technology Reference

### noVNC

- **Project:** https://github.com/novnc/noVNC
- **License:** MPL 2.0 / GPL v3 (dual-license)
- **Stack:** HTML5 Canvas + WebSocket → VNC RFB protocol
- **Pros:** No plugins, works in any modern browser, mature (10+ years)
- **Cons:** Software rendering only, moderate latency (~100-300ms)

### Selkies

- **Project:** https://github.com/selkies-project/selkies-gstreamer
- **License:** Mozilla Public License 2.0
- **Stack:** WebRTC + GStreamer H.264 encoding → browser
- **Pros:** GPU-accelerated, low latency (~50-100ms), good for media
- **Cons:** Requires GPU, complex dependencies, younger project

### Kasm Workspaces

- **Project:** https://www.kasmweb.com/ (self-hosted edition is open-source)
- **License:** GPL v3 (community edition)
- **Stack:** Docker containers + guacamole + custom browser images
- **Pros:** Enterprise features (recording, audit, SSO), multi-tenancy
- **Cons:** Heavy (Docker overhead), commercial upsell pressure, overkill for MVP

### x11vnc vs TigerVNC vs KasmVNC

- **x11vnc:** Attaches to existing X server (e.g. `:0`). Good for screen sharing. Not ideal for headless sessions.
- **TigerVNC (Xvnc):** Standalone X server with built-in VNC. Runs headless (no physical display needed).
- **KasmVNC (PoC choice):** TigerVNC fork with modern web UI, authentication, H.264 video encoding, better performance. Used by `kasmweb/desktop` images. **Recommended for PoC** — proven stack, container-ready, good web UX.

---

## Appendix C: Docker Resource Limits (PoC)

**Example Docker container with limits:**

```bash
docker run -d \
  --name tourbillon-agent-ceo-abc123 \
  --memory=512m \
  --memory-swap=768m \
  --cpus=0.5 \
  --restart=unless-stopped \
  -p 6901:6901 \
  -v /opt/tourbillon-company-acme/data:/data \
  -v /opt/tourbillon-company-acme/home/ceo:/home/kasm-user \
  kasmweb/desktop:1.15.0
```

**Check resource usage:**

```bash
docker stats tourbillon-agent-ceo-abc123
docker inspect tourbillon-agent-ceo-abc123 | jq '.[0].State'
```

**Alert when memory pressure (post-PoC):**

```bash
# Monitor docker stats → Prometheus → Grafana alert when container RAM >400MB sustained
```

---

## Appendix D: Related Documentation

- **Existing code execution:** See `packages/mastra/src/execution-workspace.ts` and `packages/mastra/src/skills/code-execution-skills.md` for LocalSandbox / bwrap implementation. Company Computer is a **sibling feature**, not a replacement. Both coexist:
  - **LocalSandbox (code-execution toolset):** Ephemeral per-issue shell command execution, no GUI, bwrap/seatbelt isolation.
  - **Company Computer (company-computer toolset, PoC):** Durable per-agent GUI environment, Docker containers with KasmVNC, persistent home dirs via bind-mounts.

- **Tourbillon architecture:** See `docs/architecture.md` for system overview, tool tiers, agent identity, wake loop.

- **Agent toolsets:** See AGENTS.md § Tool Tiers for how `assignedToolsets` gates Tier 2 boolean toolsets like `code-execution`, `web-search`, `comments`. `company-computer` follows same pattern.

---

## Document Metadata

- **Author:** Tourbillon Agent (spike generation)
- **Reviewer:** Derek (PM/Ops), Board
- **Created:** 2026-09-30
- **Status:** DRAFT for review — no implementation yet
- **Epic:** Company Computer MVP (CC1 → CC2 → CC4)
- **Gating:** HOLD per-agent VMs, HOLD bwrap-as-desktop, ACCEPT draft spike only
