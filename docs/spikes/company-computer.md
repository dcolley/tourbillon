# Company Computer Spike

**Status:** DRAFT — Option A locked (2026-09-30 Derek/PM)  
**Gating:** ACCEPT/HOLD draft only; HOLD per-agent VMs / shared display / bwrap-as-desktop

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

### Per-Company Compute + Disk

One Linux host/VM per company:
- Shared CPU, RAM, disk
- Shared company workspace filesystem (`/company`)
- Shared browser profile storage (bookmarks, history — unless explicitly private)
- Shared `/tmp` by default (per-agent subdirs optional)

### Per-Agent GUI Session

Each agent gets an isolated display session:
- Unique `DISPLAY` (`:10`, `:11`, …) or Wayland socket
- Separate window manager state (agent A's windows are invisible to agent B)
- Separate browser session (cookies, localStorage) unless explicitly shared
- Separate clipboard (no cross-agent paste unless Board intervenes)

### Optional Agent-Private Directories

Per-agent private directories under `/company/agents/{agentUrlKey}/private/` for secrets or drafts not meant for other agents. Controlled by file permissions (agent user can read/write; other agent users cannot).

### Board Access

Board members connect to **any agent's session** via the web UI. The noVNC/Selkies URL targets that agent's display. Board sees exactly what that agent sees and can take shared control.

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

**Default for Demo/TEST:** noVNC + XFCE4 on metaspan TEST. Rationale: lowest Ops risk, no GPU required, sufficient for MVP user stories (US-CC1 → CC2 → CC4).

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

### Recommended MVP Stack (metaspan TEST)

**noVNC + XFCE4 + x11vnc** with per-agent display sessions (`:10`, `:11`, …). Embedded noVNC client served by Tourbillon web app at `/agent/{urlKey}/computer`.

---

## 4. Thin Vertical Slice — MVP-0 User Stories

### US-CC1: Provision Company Computer

**As a** Board member  
**I want** to provision a Company Computer for my company  
**So that** agents can access GUI tools

**Acceptance:**
- Board visits `/settings/company-computer` and clicks "Provision"
- System provisions a Linux VM/container (or marks metaspan TEST as company's host)
- Displays company computer status: "Ready" + resource limits (RAM, CPU caps)
- No auto-provision — Board must explicitly enable

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
**I want** to watch an agent's desktop in real-time  
**So that** I can see what the agent is doing

**Acceptance:**
- Board visits `/agent/{urlKey}/computer` tab
- Page embeds noVNC client connected to agent's display
- Board sees agent's screen update in real-time (1-2 sec latency acceptable)
- Board can optionally click "Take Control" to send input (shared mouse/keyboard)

**"Done" for MVP-0:** CC1 provision → CC2 browser → CC4 shell working on Demo/TEST metaspan. CC3 file manager and CC5 Board live view are natural on option A but not strict MVP-0 blockers.

---

## 5. Session Lifecycle

### Create Session

Triggered when an agent with `company-computer` toolset first calls a `computer*` tool:

1. Check if agent already has a display session (DB: `company_computer_sessions` table with `agentId`, `displayNumber`, `vncPort`, `pid`)
2. If no session, allocate next free display (`:10`, `:11`, …)
3. Start X server: `Xvnc :10 -geometry 1920x1080 -depth 24 -rfbport 5910 -SecurityTypes None -AlwaysShared`
4. Start window manager: `DISPLAY=:10 xfce4-session &`
5. Record session in DB: `{ agentId, displayNumber: 10, vncPort: 5910, pid, createdAt }`
6. Return session handle to agent tool

### Resume Session

When agent calls `computer*` tool and session exists:

1. Look up session from DB by `agentId`
2. Verify VNC process still running (check `pid`)
3. If dead, clean up stale DB row and create new session
4. If alive, return existing session handle

### Destroy Session

Triggered by Board action or agent calls `computerCloseSession()`:

1. Kill VNC server process (`kill $pid`)
2. Kill window manager and all child processes (`pkill -TERM -s $sessionId`)
3. Clean up `/tmp/.X10-lock` and display socket
4. Delete session row from DB

### Idle Hibernate (Post-MVP)

**Problem:** N idle agent sessions consume RAM (200-500MB each) even when unused.

**Solution:** After 30min idle (no tool calls, no Board view), hibernate session:
1. Screenshot final desktop state → store in S3/disk
2. Serialize window manager state (window positions, open apps) → JSON
3. Kill VNC server and WM
4. Mark session `status: hibernated` in DB

On next tool call:
1. Restore X server and WM
2. Relaunch apps from saved state
3. Mark session `status: active`

**MVP-0:** No hibernate. All sessions stay active. Board must manually destroy unused sessions.

### Multi-Agent Concurrency

**One host, N agent sessions:**
- Display `:10` for agent A (urlKey `ceo`)
- Display `:11` for agent B (urlKey `cto`)
- Display `:12` for agent C (urlKey `eng-001`)

Each display is isolated (separate framebuffer, input queue, window list). Agents cannot see each other's screens unless they screenshot the host's `/tmp/.X11-unix/` sockets (which is intentionally blocked by filesystem permissions).

**Concurrency limit:** Start with N=10 max sessions per company (metaspan TEST limit). After 10 agents have active sessions, 11th agent tool call returns error: "Company Computer capacity exceeded. Ask Board to destroy idle sessions."

---

## 6. Ops Risks — Required Mitigation Plan

### Risk 1: RAM Pressure from N Desktop Environments

**Scenario:** 10 agents × 300MB per XFCE session = 3GB RAM for desktops alone, plus browser tabs (500MB each).

**Mitigation:**
- **Cgroup memory caps:** Each agent session in a cgroup with `memory.max = 512MB` (XFCE + Firefox). OOM killer terminates session if exceeded; agent tool returns error; agent can retry or comment "desktop OOM'd, need Board to increase limit."
- **Swap:** Configure 4GB zram swap on company VM to handle burst usage without disk I/O.
- **Board visibility:** `/settings/company-computer` dashboard shows per-agent RAM usage + total. Board can destroy idle sessions.

### Risk 2: CPU Saturation from Browser Rendering

**Scenario:** Agent opens 20 tabs with auto-play videos → 100% CPU → other agents starved.

**Mitigation:**
- **Cgroup CPU caps:** Each agent session in a cgroup with `cpu.max = 50000 100000` (50% of one core). Agent can use one core but cannot monopolize host.
- **Browser config:** Pre-configure Firefox with `media.autoplay.enabled = false`, `javascript.options.wasm = false` (reduce attack surface and CPU usage).
- **Watchdog:** If agent session uses >80% CPU for >5min, pause session and notify Board via activity log.

### Risk 3: Idle Sessions Never Reclaimed

**Scenario:** Agent finishes task, never calls `computerCloseSession()`, session stays alive forever.

**Mitigation:**
- **Session GC:** Nightly cron job (`02:00 UTC`) scans DB for sessions with `lastActivityAt > 7 days ago` and no open issues assigned to that agent. Auto-destroy those sessions; post activity log entry.
- **Board override:** Board can manually destroy any session from `/settings/company-computer` regardless of idle time.
- **Agent reminder:** Control-plane SKILL.md updated with "If you opened a Company Computer session and finished work, call `computerCloseSession()` to release resources."

### Risk 4: Disk Growth from Browser Profiles

**Scenario:** Each agent's Firefox profile under `/company/agents/{urlKey}/.mozilla/` grows to 2GB (cache, history, downloads).

**Mitigation:**
- **Disk quotas:** XFS project quotas per agent directory (`xfs_quota -x -c 'limit -p bsoft=1G bhard=2G {agentId}' /company`). Firefox cache writes fail when quota hit; agent must clean up or ask Board to increase quota.
- **Profile cleanup:** Firefox configured with `browser.cache.disk.capacity = 51200` (50MB cache max), `places.history.expiration.max_pages = 1000` (limit history DB size).
- **GC task:** Weekly cleanup deletes `/company/agents/*/Downloads/*` and `~/.cache/*` older than 30 days.

### Risk 5: Display Server Limits (X11)

**Scenario:** X11 allows displays `:0` to `:99` by default. After 100 sessions created (even if destroyed), display allocation fails.

**Mitigation:**
- **Display reuse:** When destroying a session on display `:10`, mark `:10` as free in DB. Next `createSession()` reuses `:10` instead of incrementing to `:100`.
- **Display range:** Reserve `:10` to `:50` for agent sessions (40 slots). Company with >40 active agents must provision second company VM (not MVP).

### Concrete Plan for metaspan TEST

**Host:** Ubuntu 22.04 VM with 16GB RAM, 8 vCPU, 100GB disk.

**Cgroup hierarchy:**
```
/sys/fs/cgroup/tourbillon-company-{companyId}/
  ├── agent-{agentId}-session/
  │   ├── memory.max = 512M
  │   ├── cpu.max = 50000 100000
```

**Systemd integration:**
- Each agent session is a transient systemd scope unit (`systemd-run --scope --slice=tourbillon-company-{companyId}.slice`)
- Automatic cgroup application + cleanup on exit

**Monitoring:**
- Prometheus exporter scrapes `/sys/fs/cgroup/tourbillon-company-*/` metrics
- Grafana dashboard: per-agent RAM/CPU usage, total company usage
- Alert if total company RAM >12GB or any agent >400MB sustained 10min

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

## 8. Board Live View

### UI Integration

**Location:** New "Computer" tab on agent detail page (`/agent/{urlKey}/computer`)

**Embed:** iframe or native noVNC client JavaScript:

```html
<!-- Simplified example -->
<div id="vnc-container">
  <canvas id="vnc-canvas"></canvas>
</div>
<script src="/novnc/core/rfb.js"></script>
<script>
  const rfb = new RFB(
    document.getElementById('vnc-canvas'),
    'wss://tourbillon.example.com/vnc/{agentId}',
    { credentials: { password: '' } } // No VNC password; auth via Tourbillon session
  );
</script>
```

**WebSocket proxy:** Tourbillon web app (`apps/web`) proxies `wss://tourbillon.example.com/vnc/{agentId}` to the agent's VNC port on the company VM (`ws://company-vm:5910`). Uses existing Better Auth session for authorization (Board member must be logged in and belong to the company).

### Watch vs Take Control

**Watch mode (default):**
- Board sees agent's screen in real-time
- Board cannot send input (mouse/keyboard)
- Agent is unaware Board is watching

**Take Control mode (opt-in):**
- Board clicks "Take Control" button → sends input to agent's display
- Agent desktop shows notification: "Board member {name} is now controlling this session"
- Both agent (via tools) and Board (via noVNC) can send input simultaneously (last input wins)
- Board clicks "Release Control" → back to watch mode

**Implementation:** noVNC RFB connection with `viewOnly: true` for watch mode, `viewOnly: false` for control mode. WebSocket proxy enforces mode based on Board's action.

---

## 9. Agent Tools — New Tourbillon Toolset

**Toolset name:** `company-computer`

**Gating:** `assignedToolsets` includes `company-computer` (opt-in per agent, like `code-execution`)

**Tools** (Tier 2 boolean toolset):

| Tool | Parameters | Returns | Description |
|---|---|---|---|
| `computerOpenBrowser` | `url?: string` | `{ sessionId, displayNumber }` | Open Firefox on agent's display. If `url` provided, navigate to it. If session doesn't exist, create it. |
| `computerOpenFileManager` | `path?: string` | `{ sessionId, displayNumber }` | Open file manager (Thunar) on agent's display. If `path` provided, navigate to it. |
| `computerOpenTerminal` | `cwd?: string` | `{ sessionId, displayNumber }` | Open terminal emulator (xfce4-terminal) on agent's display. If `cwd` provided, set working directory. |
| `computerScreenshot` | — | `{ imageBase64: string, width, height }` | Capture current desktop as PNG. Returns base64-encoded image. Agent can analyze with vision model or save to issue comment. |
| `computerClick` | `x: number, y: number, button?: 'left'\|'right'\|'middle'` | `{ success: boolean }` | Send mouse click to (x, y) on agent's display. Coordinates are absolute pixels (0,0 = top-left). |
| `computerTypeText` | `text: string` | `{ success: boolean }` | Send keyboard input to agent's display (focused window receives text). |
| `computerPressKey` | `key: string, modifiers?: string[]` | `{ success: boolean }` | Send special key (e.g. `Enter`, `Tab`, `Escape`) with optional modifiers (`Ctrl`, `Shift`, `Alt`). |
| `computerMouseMove` | `x: number, y: number` | `{ success: boolean }` | Move mouse to (x, y) without clicking. |
| `computerScroll` | `direction: 'up'\|'down', amount?: number` | `{ success: boolean }` | Scroll focused window. `amount` is scroll wheel ticks (default 3). |
| `computerCloseSession` | — | `{ success: boolean }` | Destroy agent's display session (kill VNC server, WM, apps). Frees resources. |
| `computerGetSessionInfo` | — | `{ sessionId, displayNumber, vncPort, active, createdAt, lastActivityAt, ramMB, cpuPercent }` | Get current session status and resource usage. |

**Tool pattern:** Mirrors Cursor `computerUse` pattern (screenshot + input) but operates over remote desktop session, not local host. These are **Tourbillon-internal tools** — not Cursor-specific tooling.

**API routes:** All tools hit new routes under `/api/internal/company-computer/*`. Routes authenticate via run-scoped Bearer token (same as existing control-plane tools). Route implementations call into `packages/company-computer/` library (new package).

**Skill file:** `packages/mastra/src/skills/company-computer-skills.md` teaches agents when to use GUI vs shell, screenshot frequency, resource cleanup.

---

## 10. Non-Goals

### Not in MVP-0

- **Per-agent VMs:** One VM per company, not per agent. Agents share compute but have isolated display sessions. Per-agent VMs may be post-MVP for high-security companies (too expensive for MVP).
- **Bwrap-as-desktop:** Do not repurpose LocalSandbox bwrap for GUI isolation. Bwrap is for ephemeral process sandboxing; Company Computer is for durable GUI sessions. Architecture mismatch.
- **Managed desktop SaaS:** Do not bind to third-party SaaS (Windows 365, Amazon WorkSpaces, etc.) in MVP. Self-hosted Linux VM only. SaaS may be post-MVP for compliance-heavy customers.
- **TEST auto-deploy:** This spike/PR does **not** enable Company Computer on tourbillon-test.example.com. No runtime changes that pull to TEST without explicit Derek approval. This is docs-only.
- **Session recording:** No built-in session replay (à la Kasm) in MVP. Board can manually screen-record via browser if needed. Audit logs are post-MVP compliance feature.
- **GPU acceleration:** No GPU passthrough or Selkies in MVP. noVNC software rendering sufficient for CC1-CC4 stories. GPU is post-MVP for media-heavy tasks.
- **Mobile Board view:** noVNC embed works on desktop only. Mobile browser support is post-MVP (touch → mouse translation is poor UX without native app).

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

- [ ] Provision single Ubuntu VM on metaspan TEST with XFCE + x11vnc
- [ ] Implement `computerOpenBrowser` + `computerScreenshot` tools
- [ ] Test: Agent calls `computerOpenBrowser('https://example.com')`, takes screenshot, includes in issue comment
- [ ] Validate cgroup RAM/CPU caps work (manually stress-test with 5 concurrent agent sessions)

### Phase 3: MVP Implementation (POST This PR)

- [ ] New package: `packages/company-computer/` (session manager, VNC proxy, cgroup setup)
- [ ] DB migration: `company_computer_sessions` table
- [ ] New toolset: `company-computer` in `role-tools.ts`
- [ ] API routes: `/api/internal/company-computer/*`
- [ ] Skill file: `company-computer-skills.md`
- [ ] UI: `/agent/{urlKey}/computer` tab with noVNC embed
- [ ] UI: `/settings/company-computer` dashboard (provision, session list, resource usage)
- [ ] Ops: Terraform/Ansible to provision company VMs with cgroups + quotas
- [ ] Docs: Update AGENTS.md with Company Computer toolset and architecture

### Phase 4: TEST Validation (HOLD Until Derek Approval)

- [ ] Deploy to tourbillon-test.example.com
- [ ] Create test company "Demo Corp"
- [ ] Provision company computer for Demo Corp
- [ ] Create test agent "TestBot" with `company-computer` toolset
- [ ] Assign issue: "Research Tourbillon competitors via Google"
- [ ] TestBot calls `computerOpenBrowser`, searches, screenshots results, posts to issue
- [ ] Board watches TestBot's desktop via noVNC live view
- [ ] Validate cgroup limits (create 10 agents, stress-test RAM/CPU)

---

## Appendix A: Rejected Options (B, C, D)

### Option B: Per-Agent VMs

**Why rejected:** Too expensive. N agents × 1GB RAM per VM = unsustainable for companies with 10+ agents. Overkill isolation (agents are cooperative, not adversarial). Provisioning time too slow (30sec per VM vs instant display allocation).

**When to revisit:** Post-MVP for enterprise customers requiring strict agent isolation (financial services, healthcare). Gated behind company setting `isolationMode: perAgentVM`.

### Option C: Managed Desktop SaaS (Windows 365 / WorkSpaces)

**Why rejected:** External dependency violates Tourbillon's local-first principle. Monthly per-seat cost adds up. SaaS vendors do not expose per-session cgroup controls (can't enforce RAM caps). Windows licensing complexity.

**When to revisit:** Post-MVP if customer explicitly requires Windows GUI tools (Excel macros, Outlook). Tourbillon can integrate as optional backend, not default.

### Option D: Bwrap-as-Desktop

**Why rejected:** Architectural mismatch. Bwrap is for ephemeral process isolation (run script → exit). Company Computer needs durable GUI sessions (survive heartbeats, persist state). Bwrap cannot isolate X11 displays (all processes in bwrap share same `DISPLAY`). No window manager support (bwrap is CLI-only sandbox).

**Confusion risk:** Developers might try to "upgrade" bwrap to support GUI, bloating LocalSandbox codebase with unrelated features. Keep concerns separate: LocalSandbox = ephemeral code execution; Company Computer = durable GUI environment.

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

### x11vnc vs TigerVNC

- **x11vnc:** Attaches to existing X server (e.g. `:0`). Good for screen sharing. Not ideal for headless sessions.
- **TigerVNC (Xvnc):** Standalone X server with built-in VNC. Runs headless (no physical display needed). **Recommended for MVP.**

---

## Appendix C: Cgroup v2 Reference

**Example systemd transient scope unit:**

```bash
systemd-run \
  --scope \
  --slice=tourbillon-company-acme.slice \
  --unit=agent-ceo-session \
  --property=MemoryMax=512M \
  --property=CPUQuota=50% \
  Xvnc :10 -geometry 1920x1080 -depth 24 -rfbport 5910 -SecurityTypes None
```

**Check resource usage:**

```bash
systemctl status agent-ceo-session
cat /sys/fs/cgroup/tourbillon-company-acme.slice/agent-ceo-session.scope/memory.current
cat /sys/fs/cgroup/tourbillon-company-acme.slice/agent-ceo-session.scope/cpu.stat
```

**Alert when memory pressure:**

```bash
# /etc/systemd/system/agent-ceo-session.scope.d/override.conf
[Unit]
OnFailure=notify-board-session-oom@%n.service
```

---

## Appendix D: Related Documentation

- **Existing code execution:** See `packages/mastra/src/execution-workspace.ts` and `packages/mastra/src/skills/code-execution-skills.md` for LocalSandbox / bwrap implementation. Company Computer is a **sibling feature**, not a replacement. Both coexist:
  - **LocalSandbox (code-execution toolset):** Ephemeral per-issue shell command execution, no GUI, bwrap/seatbelt isolation.
  - **Company Computer (company-computer toolset):** Durable per-company GUI environment, agent display sessions, X11/VNC.

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
