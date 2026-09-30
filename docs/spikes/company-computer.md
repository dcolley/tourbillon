# Company Computer Spike

**Status:** DRAFT — Option A locked (2026-09-30 Derek/PM)  
**Gating:** ACCEPT/HOLD draft only; HOLD per-agent VMs / shared display / bwrap-as-desktop  
**Product Lock:** Two-gate model (2026-09-30 Derek/PM) — company config gates host provision; agent config gates agent home

---

## Executive Summary

**Company Computer** provides a durable, shared Linux desktop environment per company where Tourbillon agents can drive GUI applications (browser, file manager, shell) and the Board can watch/help in real-time. This is **option A: full desktop remote** — a single Linux host/VM per company running a lightweight desktop environment (XFCE/GNOME lite) with noVNC / Kasm / Selkies web-based access.

**Two-Gate Provisioning Model:**

1. **Company-level gate:** Company config/settings determine whether a company computer host/VM is provisioned for that company. No company computer = no agent GUI sessions for any agent in that company.
2. **Agent-level gate:** Agent config field `hasComputer` (boolean) determines whether `/home/{agentId}` workspace is created on the company computer for that specific agent. The `company-computer` toolset does **not** bypass this gate — home creation requires `hasComputer === true` regardless of toolset assignment. Agent without `hasComputer` enabled cannot use `computer*` tools even if company computer exists.

**Failure mode:** If company computer is not provisioned but an agent has `hasComputer` enabled, agent tool calls return clear error (e.g., "Company Computer not provisioned. Ask Board to enable at /settings/company-computer."). Agents must **not** provision private hosts or fall back to per-agent VMs. The company computer is either centrally provisioned or unavailable.

**Outcome:** Agents gain persistent GUI capability for tasks requiring visual interfaces (web research, admin dashboards, file browsing), while Board members can observe agent actions live and intervene when needed. The company computer complements the existing **LocalSandbox / bwrap code execution** — it does not replace it. Code execution remains per-issue ephemeral; Company Computer provides a shared, durable GUI environment.

---

## 0. Two-Gate Provisioning Model (Product Lock 2026-09-30)

### Gate 1: Company-Level Provisioning

**Scope:** Determines whether a company computer host/VM exists for the entire company.

**Control:** Company settings (e.g., `/settings/company-computer` page) or DB field (`companies.computerEnabled` or `company_computers` table row).

**Effect:**
- **Enabled:** Company computer host/VM is provisioned. Agents with `hasComputer` can create GUI sessions.
- **Disabled:** No company computer host exists. All agent `computer*` tool calls return error regardless of agent-level config. Board UX hides Computer panel on all agent detail pages.

**Board action:** Board visits `/settings/company-computer` and clicks "Provision" (or "Enable Company Computer"). System provisions Linux host/VM (or marks metaspan TEST as company's host). Board can also deprovision (destroys host and archives/deletes all agent homes with confirmation dialog).

**Failure mode:** If company computer not provisioned, agents with `hasComputer` enabled receive clear error message. Agents must **not** provision private VMs or fall back to per-agent hosts. The company computer is either centrally provisioned or unavailable.

### Gate 2: Agent-Level Home Directory

**Scope:** Determines whether a specific agent gets `/home/{agentId}` workspace on the company computer.

**Control:** Agent config field `agents.hasComputer` (boolean). The `company-computer` toolset does **not** bypass this gate — home creation strictly requires `hasComputer === true`.

**Effect:**
- **Enabled (`hasComputer === true`):** When agent first calls a `computer*` tool, system creates `/home/{agentId}` on company computer (after verifying company gate satisfied). Agent can use GUI tools, persist state.
- **Disabled (`hasComputer === false` or null):** Agent cannot create GUI sessions or home directory even if company computer exists and toolset is assigned. Tool calls return error: "Agent does not have Computer access. Ask Board to enable hasComputer on agent detail page." Board UX hides Computer panel for this agent.

**Board action:** Board edits agent on agent detail page, enables "Computer Access" or "hasComputer" capability (checkbox or toggle). To revoke access, Board disables capability; system archives or deletes `/home/{agentId}` according to chosen teardown semantics (documented in implementation).

**Toolset relationship:** The `company-computer` toolset (if it exists as a Tier 2 boolean toolset) may control which Computer tools are available to the agent, but it does **not** create `/home/{agentId}` or bypass the `hasComputer` gate. Home provisioning is gated solely by `hasComputer` field.

### Ordering and Cascade

**Ordering constraint:** Company provisioning precedes agent home creation. Implementation flow:

1. **Company provisioning** (Board at `/settings/company-computer` → Provision)
2. **Agent home creation** (agent with `hasComputer` calls `computer*` tool → system creates `/home/{agentId}` on provisioned host)

**Cascade on company deprovision:** Deprovisioning company computer destroys all agent sessions and archives/deletes all `/home/{agentId}` directories. Board must confirm data loss before proceeding. Activity log entry records cascade.

**Cascade on agent disable:** Disabling agent `hasComputer` destroys that agent's session and archives/deletes `/home/{agentId}`. Does **not** provision private VM for that agent (no orphan agent hosts).

### Test Gate (MVP-0 Implement Blocker)

**Gate for Test acceptance:** Implement PRs that provision company computer **without** checking company-level config, or create agent homes **without** checking agent `hasComputer`, will be **HELD by Test**. Spike and US-CC stories document these gates as acceptance criteria. Implementers must verify both gates in code before allowing provision/session-create operations.

---

## 1. Outcome

### Agent Capabilities

Agents with Company Computer access (agent has `hasComputer` enabled **and** company computer is provisioned) can:
- Browse the web (research, form filling, admin dashboards)
- Navigate the company filesystem via GUI file manager
- Run interactive shell sessions with persistent state
- Use visual tools (text editors, image viewers, diff tools)
- Leave work in progress across heartbeats (browser tabs, file manager state)

**Gating:** Both gates must be satisfied:
1. **Company gate:** Company computer host/VM provisioned for the company (Board action at `/settings/company-computer`)
2. **Agent gate:** Agent `hasComputer === true` (Board action on agent detail page)

The `company-computer` toolset (if implemented) does **not** bypass the agent gate — home creation and Computer access require `hasComputer === true` regardless of toolset assignment.

If company computer is not provisioned, agent tool calls return error regardless of agent gate. Board must provision company computer first.

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

One Linux host/VM per company (when company computer is provisioned):
- Shared CPU, RAM, disk
- Shared company workspace filesystem (`/company`)
- Shared browser profile storage (bookmarks, history — unless explicitly private)
- Shared `/tmp` by default (per-agent subdirs optional)

**Provisioning order:** Company computer host must be provisioned (via Board action at `/settings/company-computer`) before any per-agent homes are created. Agents with `hasComputer` enabled on a company without provisioned computer cannot create GUI sessions or private hosts.

### Per-Agent Home Directory

Each agent with `hasComputer` enabled gets a home directory on the company computer:
- Location: `/home/{agentId}` (or `/company/agents/{agentUrlKey}/` — implementation choice)
- Created when agent first calls a `computer*` tool (after verifying company computer exists)
- Persists across heartbeats and agent sessions
- Contains agent-private config (`.bashrc`, `.mozilla/`, `.cache/`)
- File permissions: agent user owns directory; other agents cannot read/write without explicit ACLs

**Agent-level teardown:** When `hasComputer` is disabled for an agent:
- **Safe option (recommended):** Archive `/home/{agentId}` to `/archive/{agentId}-{timestamp}.tar.gz` and remove from active filesystem. Board can restore if needed.
- **Destructive option:** Delete `/home/{agentId}` entirely (data loss; acceptable if explicitly documented in UI).
- **No orphan VMs:** Disabling `hasComputer` does **not** provision a private VM for that agent. Agent loses GUI access; must re-enable `hasComputer` or use non-GUI tools only.

### Per-Agent GUI Session

Each agent with `hasComputer` gets an isolated display session (when company computer is provisioned):
- Unique `DISPLAY` (`:10`, `:11`, …) or Wayland socket
- Separate window manager state (agent A's windows are invisible to agent B)
- Separate browser session (cookies, localStorage) unless explicitly shared
- Separate clipboard (no cross-agent paste unless Board intervenes)

### Optional Agent-Private Directories (Legacy)

Per-agent private directories under `/company/agents/{agentUrlKey}/private/` for secrets or drafts not meant for other agents. Controlled by file permissions (agent user can read/write; other agent users cannot).

**Note:** This is superseded by `/home/{agentId}` model above. Implementation may consolidate to `/home/{agentId}` only.

### Board Access

Board members connect to **any agent's session** via the web UI. The noVNC/Selkies URL targets that agent's display. Board sees exactly what that agent sees and can take shared control.

---

## 3. Provisioning Backends

### Product Constraint (Derek/PM 2026-09-30)

**Not feasible for Board/Derek to spin up computers manually** when a company is created or company computer is enabled. Enabling company computer in company config (`/settings/company-computer` → Provision) must trigger **automated provision** of the host/VM.

**Control-plane hook:** Company config enable → provisioner backend → host ready → agents with `hasComputer` can create `/home/{agentId}` homes.

**Gate preservation:** The two-gate model remains intact:
1. **Gate 1 (Company):** Enabling company computer in config triggers automated provision of host
2. **Gate 2 (Agent):** `hasComputer === true` triggers creation of `/home/{agentId}` on the provisioned host

Provisioning backends are orthogonal to the `hasComputer` gate — the backend determines **how** the company computer host is created, not whether agent homes are created.

### Backend Options

#### Option 1: One VM per Company (Cloud Provider API)

**Stack:**
- Cloud provider API (AWS EC2, GCP Compute Engine, DigitalOcean, Hetzner Cloud)
- Terraform or cloud SDK (boto3, google-cloud-compute, etc.)
- Cloud-init or golden AMI/image with XFCE + VNC pre-installed
- Single Linux VM per company (shared by all agents with `hasComputer`)

**Provision flow:**
1. Board enables company computer in config → `POST /api/settings/company-computer/enable`
2. Tourbillon backend calls cloud API: `create_instance(name="company-{companyId}", image="golden-xfce-vnc", size="2cpu-4gb")`
3. Cloud-init script or golden image boots XFCE + VNC, creates `/home` directory structure
4. Backend polls instance until SSH/VNC reachable (health check)
5. Record `company_computers` row: `{ companyId, hostIp, vncPort, status: 'ready', provisionedAt }`
6. Return success to Board; agents with `hasComputer` can now create homes

**Pros:**
- Clean isolation per company (one VM = one company; no cross-company risk)
- Standard cloud ops (SSH access, monitoring, backups via cloud provider snapshots)
- Matches current MVP Option A design (§ 4 noVNC + XFCE)
- Easy to scale resources per company (Board can resize VM via API if needed)
- Well-understood failure modes (VM crashes → reprovision; agent homes persist if EBS/persistent disk)

**Cons:**
- Higher cost per company (~$20-50/mo per VM depending on size and provider)
- Slower provision time (30-90 seconds to boot VM + cloud-init)
- Requires cloud provider credentials and API integration
- Ops overhead: patch management, monitoring, VM lifecycle (stop/start/terminate)

**Tradeoffs:**
- Best for production multi-tenant SaaS (each company pays for their VM)
- Overkill for single-company self-hosted Tourbillon (one VM for one company = no multi-tenancy benefit)
- Suitable for metaspan TEST (can provision one VM per test company)

**Recommendation:** **Use for production multi-tenant SaaS** where companies are billed per seat or per resource usage. Not recommended for MVP PoC (too slow for rapid iteration).

---

#### Option 2: Kasmweb Docker Images (Standalone) — **MVP Recommended**

**Stack:**
- Docker Engine API on **localhost** (same host as Tourbillon; no Kasm Admin UI required)
- Kasmweb Docker images: `kasmweb/chrome`, `kasmweb/desktop`, `kasmweb/ubuntu-jammy-desktop`
- One container per company on localhost; agents with `hasComputer` get `/home/{agentId}` mounts
- KasmVNC embedded in container (noVNC on port 6901 by default)
- Tourbillon proxies HTTPS iframe/embed; VNC password rotated per provision

**Provision flow:**
1. Board enables company computer at `/settings/company-computer` → selects image from allowlist (`kasmweb/desktop`, `kasmweb/chrome`, etc.)
2. Tourbillon backend calls Docker API:
   ```bash
   docker run -d \
     --name=tourbillon-company-{companyId} \
     --shm-size=512m \
     -e VNC_PW={rotated-password} \
     -p 6901:6901 \
     -v tourbillon-company-{companyId}:/home/kasm-user \
     kasmweb/ubuntu-jammy-desktop:1.15.0
   ```
3. Container boots desktop + KasmVNC in ~5-10 seconds
4. Backend health-checks `https://localhost:6901` (KasmVNC endpoint)
5. Record `company_computers` row: `{ companyId, containerId, imageId, vncUrl, vncPassword, status: 'ready' }`
6. Agents with `hasComputer === true` create `/home/{agentId}` subdirs inside container volume
7. Return success; Board sees VNC embed in Computer tab

**Images:**
- **`kasmweb/desktop`** or **`kasmweb/ubuntu-jammy-desktop`** — **Default/preferred (Derek 2026-09-30).** Full XFCE desktop with terminal, file manager, browser. **Recommended for full computer toolset** (terminal + files + browser).
- **`kasmweb/chrome`** — Browser-only (Chromium). Good for web research, form filling. **Not** full computer toolset (no terminal, no file manager).
- **Core + apps** — Install additional tools via `docker exec` or custom Dockerfile if needed.

**Company config (align with two-gate model):**
- Company: `hasComputer` (boolean, enables company computer) + `imageId` (string, selected from allowlist; **default: `kasmweb/ubuntu-jammy-desktop`**)
- Agent: `hasComputer` (boolean, gates `/home/{agentId}` creation)
- Board UI: Company settings page shows toggle + image picker (dropdown or radio buttons with `kasmweb/ubuntu-jammy-desktop` as default selection)

**Pros:**
- Fast provision (5-10 seconds vs 30-90 seconds for VM)
- Low cost (containers share localhost resources; ~1-2GB RAM per company)
- **No Kasm Admin UI required for MVP** (Tourbillon uses Docker API directly via unix socket)
- Simple ops (Docker Engine on **localhost only**; no cloud provider, no remote DOCKER_HOST)
- KasmVNC built-in (better browser compatibility than plain VNC; audio/clipboard support)
- Good for PoC and TEST (rapid iteration, no Kasm licensing or admin setup)
- Easy teardown (docker stop + docker rm)
- Image flexibility (Board selects browser-only vs full desktop per company)

**Cons:**
- **Localhost-only for MVP** (all containers run on same host as Tourbillon; remote DOCKER_HOST is post-MVP)
- Weaker isolation than VMs (containers share kernel; container escape affects host)
- Multi-agent DISPLAY inside single container requires `/home/{agentId}` subdirs (not separate X displays per agent — all agents share one desktop session per company)
- Port allocation required (6901, 6902, 6903… for N companies or dynamic port mapping on localhost; Tourbillon proxy handles routing)
- Persistent storage requires Docker volumes (`/home/kasm-user` mounted per company)
- Not suitable for high-security multi-tenant SaaS (container escape risk; prefer VM per company for production)

**Tradeoffs:**
- **Best for MVP PoC and TEST** (fast iteration, low cost, no Kasm Admin setup, validates two-gate model quickly)
- Suitable for single-company self-hosted Tourbillon (one container for one company's agents)
- **Chrome-only image (`kasmweb/chrome`) is fine for browser-only PoC** but does **not** support full computer toolset (no terminal/file manager)
- **For full computer toolset (browser + terminal + files), use `kasmweb/desktop` or `ubuntu-jammy-desktop`**
- Not recommended for production multi-tenant SaaS (security/isolation concerns; migrate to VM per company or full Kasm Workspaces)

**Recommendation:** **Use for MVP PoC** (Path A: Standalone Docker). Start with `kasmweb/ubuntu-jammy-desktop` for full computer toolset validation. Consider migrating to Option 2B (Full Kasm Workspaces) for multi-tenant production if audit/compliance features are needed, or Option 1 (VM per company) for stronger isolation.

---

#### Option 2B: Kasmweb Full Workspaces (Multi-Tenant Later)

**Stack:**
- Kasm Workspaces self-hosted edition (includes Admin UI + Developer API)
- Admin UI manages Images, API keys, Users/Groups, Workspaces, session recording
- Developer API: `request_kasm`, `get_kasm_status`, `destroy_kasm`, `get_images`, `exec_command_kasm`, `set_session_permissions` (view-only share)
- Tourbillon integrates via Kasm Developer API (not Docker API directly)

**Provision flow:**
1. Board enables company computer → Tourbillon calls Kasm API: `POST /api/public/request_kasm { image_id, user_id, ... }`
2. Kasm Workspaces provisions Docker container per company or per agent session
3. Kasm returns Kasm ID and session URL (noVNC endpoint managed by Kasm)
4. Tourbillon records Kasm ID and embeds session URL in Computer tab
5. Agents with `hasComputer` use `exec_command_kasm` API to create `/home/{agentId}` or run tools
6. Board uses `set_session_permissions` API for takeover (view-only share vs full control)

**Pros:**
- Enterprise features out-of-box (session recording, audit logs, user management, SSO)
- Pre-built multi-tenancy (Kasm manages users, groups, workspaces; Tourbillon delegates provisioning)
- GPU acceleration available (Selkies backend) for media-heavy tasks
- Admin UI for Ops (image management, session monitoring, resource quotas)
- Turnkey desktop SaaS (less custom VNC/XFCE plumbing; Kasm handles it)
- API-driven takeover via `set_session_permissions` (aligns with watch/takeover protocol)

**Cons:**
- Additional dependency (Kasm Workspaces stack, not just Docker Engine)
- Commercial licensing for advanced features (free tier may suffice for MVP; paid for enterprise)
- Heavier ops setup (Kasm Admin UI + API keys + user/group management)
- Higher resource usage than standalone Docker (Kasm orchestration overhead)
- Learning curve (Kasm API + auth + admin concepts)
- Overkill for MVP PoC (many features unused in early validation)

**Tradeoffs:**
- Best for **multi-tenant production SaaS** requiring compliance features (SOC2, audit logs, session replay)
- Suitable for **high-security SaaS** (Kasm isolation + enterprise features > raw Docker)
- Not recommended for **MVP PoC** (too heavy; delays validation of core two-gate model)
- Consider **after** Option 2 (Standalone Docker) validates product-market fit and customers demand audit/compliance

**Recommendation:** **Defer to post-MVP** unless enterprise compliance is a hard requirement from day one. Use Option 2 (Standalone Docker) for PoC; migrate to Option 2B (Full Kasm Workspaces) if customers demand session recording, audit logs, or SSO integration.

---

#### Option 3: Selkies GStreamer (GPU-Accelerated)

**Stack:**
- Selkies GStreamer WebRTC streamer (GPU-accelerated H.264 encoding)
- Standalone desktop environment (GNOME or KDE Plasma)
- WebRTC instead of VNC (lower latency, better for media-heavy tasks)
- Tourbillon integrates via Selkies launch script or Docker image

**Provision flow:**
1. Board enables company computer → Tourbillon backend launches Selkies container or VM
2. Selkies starts X server + window manager + WebRTC streamer with GPU encoding (NVENC/VAAPI)
3. Backend health-checks WebRTC endpoint
4. Record company computer with WebRTC URL
5. Agents with `hasComputer` create homes; Board embeds WebRTC stream in Computer tab

**Pros:**
- GPU-accelerated rendering and video encoding (better for media playback, 3D, image editing)
- Lower latency than VNC (WebRTC vs VNC protocol)
- Good for tasks requiring GPU (e.g., Chrome with WebGL, video editing, Blender)

**Cons:**
- Requires GPU on host (NVIDIA preferred, Intel integrated possible)
- More complex setup (GStreamer plugins, NVENC/VAAPI drivers)
- Higher memory per session (~500MB vs ~200MB for VNC)
- Not needed for MVP (browser + terminal + file manager do not require GPU)

**Tradeoffs:**
- Best for post-MVP if agents need GPU-heavy GUI apps (media editing, 3D tools, WebGL)
- Not recommended for MVP PoC (GPU overhead; VNC sufficient for browser/terminal/files)

**Recommendation:** **Defer to post-MVP** unless GPU tasks are a hard requirement. Use Option 2 (Kasmweb Standalone Docker) for PoC; migrate to Selkies if customers need GPU acceleration.

---

#### Option 4: E2B Desktop / Daytona / Mastra SandboxComputer Adapter

**Stack:**
- Third-party desktop sandbox API (E2B Desktop, Daytona Workspaces, or hypothetical Mastra SandboxComputer)
- Tourbillon backend calls sandbox API: `create_desktop_sandbox(company_id)`
- Sandbox provider manages VM/container lifecycle, VNC endpoint, storage
- Tourbillon records sandbox ID and connects agents via provider's noVNC URL

**Provision flow:**
1. Board enables company computer → `POST /api/settings/company-computer/enable`
2. Tourbillon backend calls E2B/Daytona API: `POST /sandboxes { type: "desktop", duration: "persistent" }`
3. Sandbox provider returns VNC URL and sandbox ID in ~5-20 seconds
4. Tourbillon records `company_computers` row: `{ companyId, sandboxId, vncUrl, status: 'ready' }`
5. Agents with `hasComputer` create homes via sandbox provider's filesystem API or SSH
6. Return success; Board embeds provider's noVNC URL in UI

**Pros:**
- Zero Ops for Tourbillon (sandbox provider handles VM lifecycle, monitoring, storage)
- Fast provision (provider optimizes boot time with warm pools)
- Scalable (provider handles multi-tenancy and resource limits)
- Pay-per-use (no idle VM cost if provider bills per active session)

**Cons:**
- External dependency and vendor lock-in (E2B/Daytona downtime affects Tourbillon)
- Cost uncertainty (provider pricing may be higher than self-hosted VM)
- Limited customization (cannot install custom XFCE config or system packages)
- Data residency concerns (agent homes stored on provider's infrastructure)
- API integration effort (provider SDK + auth + lifecycle hooks)

**Tradeoffs:**
- Best for SaaS startups wanting to **avoid Ops entirely** (trade cost for simplicity)
- Suitable for MVP PoC if E2B Desktop or Daytona API is mature and documented
- Not suitable if data residency or air-gapped deployment is required

**Recommendation:** **Evaluate for MVP PoC if E2B Desktop API is available** (fast iteration, zero Ops). Fall back to Option 2 (Docker webtop) if provider integration is too complex or pricing is unclear. Consider for production if Ops team is small and cost is acceptable.

---

### Recommended MVP PoC Backend

**Option 2: Kasmweb Standalone Docker (localhost)** — Derek product lock 2026-09-30

**MVP architecture:**
- **Standalone Docker on localhost** (same host as Tourbillon web app and scheduler)
- Tourbillon-test is a Proxmox VM → Docker runs on **that same VM** (unix socket / local Engine API)
- **One Docker daemon on localhost runs N company containers** (one per company)
- **Remote DOCKER_HOST is post-MVP** (not recommended for MVP; adds network complexity and failure modes)
- **Default/preferred image:** `kasmweb/desktop` (full toolset: browser + terminal + file manager) or `kasmweb/ubuntu-jammy-desktop`

**Rationale:**

1. **Fast provision** (5-10 seconds) enables rapid PoC iteration and TEST validation
2. **Low cost** (containers share localhost resources; no per-company VM bill or network overhead)
3. **Simple setup** (local Docker socket; no remote DOCKER_HOST, no Kasm Admin UI, no cloud provider)
4. **KasmVNC built-in** (better browser compatibility than plain VNC; audio/clipboard support)
5. **Image flexibility** (Board selects `kasmweb/desktop` for full toolset or `kasmweb/chrome` for browser-only)
6. **Good enough isolation** for TEST and single-company self-hosted (not production multi-tenant SaaS)
7. **Easy teardown** (docker stop/rm) for PoC experimentation
8. **Localhost simplicity** (no network routing, no firewall rules, no remote host provisioning; unix socket only)

**Migration path for production:**
- **Self-hosted multi-tenant SaaS → Option 1** (VM per company) for stronger isolation and standard cloud ops
- **Remote Docker hosts → post-MVP** if localhost resource exhaustion becomes an issue (requires DOCKER_HOST routing and failure handling)
- **Enterprise customers → Option 2B** (Full Kasm Workspaces) if compliance/audit features become hard requirements
- **GPU tasks → Option 3** (Selkies) if agents need GPU acceleration for media/3D
- **Zero-Ops SaaS startup → Option 4** (E2B/Daytona) if provider pricing is acceptable and API is mature

**Implementation sketch (MVP: localhost Docker):**

```typescript
// packages/company-computer/src/backends/kasmweb-standalone.ts
import Docker from 'dockerode';
import { generatePassword } from './utils';

export async function provisionCompanyComputer(
  companyId: string,
  imageId: string, // Default: 'kasmweb/desktop' or 'kasmweb/ubuntu-jammy-desktop'
): Promise<CompanyComputerHost> {
  // Connect to local Docker daemon via unix socket (MVP: localhost only)
  const docker = new Docker({ socketPath: '/var/run/docker.sock' });
  
  // Validate imageId against allowlist
  const ALLOWED_IMAGES = [
    'kasmweb/ubuntu-jammy-desktop:1.15.0', // Preferred default (full toolset)
    'kasmweb/desktop:1.15.0',              // Alternative full desktop
    'kasmweb/chrome:1.15.0',               // Browser-only (not full toolset)
  ];
  if (!ALLOWED_IMAGES.includes(imageId)) {
    throw new Error(`Image ${imageId} not in allowlist`);
  }
  
  // Pull image if not present on localhost
  await docker.pull(imageId);
  
  // Rotate VNC password per provision
  const vncPassword = generatePassword(16);
  
  // Create container on localhost with persistent volume for /home
  const container = await docker.createContainer({
    name: `tourbillon-company-${companyId}`,
    Image: imageId,
    Env: [`VNC_PW=${vncPassword}`],
    ExposedPorts: { '6901/tcp': {} }, // KasmVNC HTTPS port
    HostConfig: {
      PortBindings: { '6901/tcp': [{ HostPort: '0' }] }, // dynamic localhost port
      ShmSize: 512 * 1024 * 1024, // 512MB shared memory for browser
      Memory: 4 * 1024 * 1024 * 1024, // 4GB RAM limit
      NanoCpus: 2 * 1e9, // 2 CPU cores
      Mounts: [{
        Type: 'volume',
        Source: `tourbillon-company-${companyId}-home`,
        Target: '/home/kasm-user', // Kasmweb home directory
      }],
    },
  });
  
  await container.start();
  
  // Wait for KasmVNC endpoint to be ready on localhost
  const info = await container.inspect();
  const hostPort = info.NetworkSettings.Ports['6901/tcp'][0].HostPort;
  const vncUrl = `https://localhost:${hostPort}`; // KasmVNC serves HTTPS on localhost
  
  await waitForHealthy(vncUrl); // poll until 200 OK (may take 5-10 sec)
  
  return {
    companyId,
    backend: 'kasmweb-standalone-localhost', // MVP: localhost only
    containerId: container.id,
    imageId,
    vncUrl, // localhost URL; Tourbillon proxies to Board via wss://
    vncPassword, // store encrypted in DB
    status: 'ready',
    provisionedAt: new Date(),
  };
}
```

**MVP constraints:**
- Docker daemon runs on **localhost** (same host as Tourbillon web app)
- Tourbillon-test Proxmox VM → Docker on that same VM (no remote DOCKER_HOST)
- All containers bind to localhost ports (dynamic port allocation)
- Tourbillon web app proxies VNC via WebSocket (`wss://tourbillon.example.com/vnc/{agentId}` → `ws://localhost:{hostPort}`)
- **Remote DOCKER_HOST is post-MVP** (requires network routing, firewall rules, remote host provisioning)

**Control-plane hook:**

```typescript
// apps/web/app/api/settings/company-computer/enable/route.ts
import { provisionCompanyComputer } from '@tourbillon/company-computer/backends/kasmweb-standalone';

export async function POST(req: Request) {
  const { companyId, imageId } = await req.json(); // Board selects image from allowlist
  const { userId } = await extractAdminContext(req); // Board auth
  
  // Check if already provisioned
  const existing = await db.query.companyComputers.findFirst({
    where: eq(companyComputers.companyId, companyId),
  });
  if (existing) return NextResponse.json({ error: 'Already provisioned' }, { status: 409 });
  
  // Trigger automated provision with selected image
  const host = await provisionCompanyComputer(companyId, imageId);
  
  // Record in DB (encrypt vncPassword before storing)
  await db.insert(companyComputers).values({
    id: createId(),
    companyId,
    backend: host.backend,
    containerId: host.containerId,
    imageId: host.imageId,
    vncUrl: host.vncUrl,
    vncPassword: await encrypt(host.vncPassword), // encrypt before store
    status: host.status,
    provisionedAt: host.provisionedAt,
  });
  
  // Activity log
  await createActivityLogEntry({
    companyId,
    userId,
    action: 'company_computer_provisioned',
    details: { imageId, backend: host.backend },
  });
  
  return NextResponse.json({ success: true, host });
}
```

**Deprovision cascade:**

```typescript
export async function deprovisionCompanyComputer(companyId: string): Promise<void> {
  const host = await db.query.companyComputers.findFirst({
    where: eq(companyComputers.companyId, companyId),
  });
  if (!host) throw new Error('Company computer not provisioned');
  
  const docker = new Docker();
  const container = docker.getContainer(host.containerId);
  
  // Archive agent homes from container volume (optional)
  // ... exec tar -czf /archive/company-{companyId}-{timestamp}.tar.gz /config ...
  
  // Stop and remove container
  await container.stop();
  await container.remove({ v: true }); // remove volumes
  
  // Delete DB row
  await db.delete(companyComputers).where(eq(companyComputers.id, host.id));
}
```

---

### Backend Abstraction (Future)

To support multiple backends (VM, Docker, Kasm, E2B), implement a `CompanyComputerBackend` interface:

```typescript
// packages/company-computer/src/backends/interface.ts
export interface CompanyComputerBackend {
  provision(companyId: string): Promise<CompanyComputerHost>;
  deprovision(companyId: string): Promise<void>;
  healthCheck(host: CompanyComputerHost): Promise<boolean>;
  createAgentHome(host: CompanyComputerHost, agentId: string): Promise<string>; // returns /home/{agentId} path
}

// Implementations:
// - DockerWebtopBackend (Option 2, MVP PoC)
// - CloudVMBackend (Option 1, production SaaS)
// - KasmBackend (Option 3, enterprise)
// - E2BDesktopBackend (Option 4, zero-Ops)
```

Backend selection via company settings or global env var (`COMPANY_COMPUTER_BACKEND=docker-webtop`).

---

## 4. MVP Path A — Recommended Stack

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

## 5. Thin Vertical Slice — MVP-0 User Stories

### US-CC1: Provision Company Computer (Company-Level Gate)

**As a** Board member  
**I want** to provision a Company Computer host/VM for my company  
**So that** agents with `hasComputer` can access GUI tools

**Acceptance:**
- Board visits `/settings/company-computer` and clicks "Provision" (or "Enable Company Computer")
- Board selects image from allowlist (`kasmweb/ubuntu-jammy-desktop`, `kasmweb/chrome`, etc.) via dropdown or radio buttons
- System triggers **automated provision** of Docker container (or VM for production) with selected image
- Backend creates container, rotates VNC password, mounts persistent volume, health-checks endpoint
- Displays company computer status: "Ready" + image name + resource limits (RAM, CPU caps)
- **Automated provision:** Board action triggers provision; no manual VM spin-up by Derek/Ops required
- **Gate behavior:** Until provisioned, no agent can create GUI sessions even if agent `hasComputer` is enabled. Agent tool calls return error: "Company Computer not provisioned. Ask Board to enable at /settings/company-computer."
- **Idempotent provision:** If already provisioned, "Provision" button shows "Already Provisioned" or "Re-provision" (recreate host). Existing agent homes are preserved or explicitly warned about data loss.

**Test Gate (MVP-0 Implement):** Implement PRs that provision a company computer **without** checking company-level config/flag will be HELD. The provision flow must verify company settings allow provisioning. Spike/US-CC must document this gate so implementers inherit the constraint.

### US-CC2: Agent Uses Browser (Agent-Level Gate)

**As an** agent with `hasComputer === true` (and company computer provisioned)  
**I want** to open a browser and search the web  
**So that** I can research a task

**Acceptance:**
- **Precondition:** Company computer is provisioned (company-level gate satisfied)
- **Precondition:** Agent `hasComputer === true` (agent-level gate satisfied; toolset assignment alone does not satisfy this gate)
- Agent calls `computerOpenBrowser(url)` tool → spawns `firefox` on agent's display in `/home/{agentId}` workspace
- Agent calls `computerScreenshot()` → returns base64 PNG of current desktop
- Agent calls `computerClick(x, y)` → sends mouse click to agent's display
- Agent calls `computerTypeText(text)` → sends keyboard input to agent's display
- Agent can navigate browser, read rendered content via screenshots
- Browser state persists across heartbeats (tabs remain open in `/home/{agentId}/.mozilla/`)
- **Gate failure:** If company computer not provisioned, tool returns error: "Company Computer not provisioned. Ask Board to enable at /settings/company-computer." Agent cannot proceed.
- **Gate failure:** If agent `hasComputer` disabled, tool returns error: "Agent does not have Computer access. Ask Board to enable hasComputer on agent detail page." Agent cannot proceed.

**Test Gate (MVP-0 Implement):** Implement PRs that create agent homes (`/home/{agentId}`) or GUI sessions **without** checking agent `hasComputer` config will be HELD. The agent tool flow must verify agent settings allow computer access. Spike/US-CC must document this gate so implementers inherit the constraint.

### US-CC3: Agent Uses File Manager (Agent-Level Gate, Natural on A)

**As an** agent with `hasComputer === true` (and company computer provisioned)  
**I want** to open a file manager GUI  
**So that** I can browse company workspace visually

**Acceptance:**
- **Precondition:** Company computer is provisioned (company-level gate satisfied)
- **Precondition:** Agent `hasComputer === true` (agent-level gate satisfied; toolset assignment alone does not satisfy this gate)
- Agent calls `computerOpenFileManager(path)` → spawns `thunar` or `nautilus` on agent's display
- Agent sees directory tree, can navigate folders via clicks (company workspace `/company` and agent home `/home/{agentId}`)
- Agent can drag/drop files (detectable via screenshots)
- File manager state persists (last visited directory remembered in `/home/{agentId}/.config/`)
- **Gate failure:** If company computer not provisioned or agent `hasComputer` disabled, tool returns same errors as US-CC2

### US-CC4: Agent Uses Shell in Desktop (Agent-Level Gate)

**As an** agent with `hasComputer === true` (and company computer provisioned)  
**I want** to open a terminal emulator in the desktop  
**So that** I can run commands interactively

**Acceptance:**
- **Precondition:** Company computer is provisioned (company-level gate satisfied)
- **Precondition:** Agent `hasComputer === true` (agent-level gate satisfied; toolset assignment alone does not satisfy this gate)
- Agent calls `computerOpenTerminal()` → spawns `xfce4-terminal` on agent's display with CWD `/home/{agentId}`
- Agent can type commands, see output via screenshots
- Shell session persists (history in `/home/{agentId}/.bash_history`, environment variables) across heartbeats
- Agent can run long-running processes (tail, watch) that survive heartbeat completion
- **Gate failure:** If company computer not provisioned or agent `hasComputer` disabled, tool returns same errors as US-CC2

### US-CC5: Board Live View (Two-Gate UX, Natural on A)

**As a** Board member  
**I want** to watch an agent's desktop in real-time while chatting with the agent  
**So that** I can see what the agent is doing and collaborate

**UX Lock (Derek/PM 2026-09-30):**  
Board views Company Computer **from the Tourbillon web app while chatting to the agent**. Right-hand (or equivalent) **Computer** tab next to chat, showing that agent's GUI session (browser + file manager + shell), labeled e.g. "**\<Agent\>'s screen**". Same feel as Grok Bot Details/Media/Computer.

This is **the destination for US-CC5 / Board live-view** for option A (noVNC/Selkies embed of the agent's display). MVP-0 can be a thinner watch mode, but product intent is **chat-adjacent Computer panel**, not a separate desktop-only page.

**Agent Detail Screen Layout (Derek/PM 2026-09-30):**
1. **Default after agent exists = chat** (not Overview/config). When Board navigates to an agent, they land in chat view first.
2. **Agent config** (Overview, settings, capabilities) = navigate / modal / popup off that chat default — **not the primary chrome**. Configuration is secondary to the conversation.
3. **Computer panel** = optional layouts:
   - **Hidden** — Computer tab not visible (company computer not provisioned **OR** agent `hasComputer !== true` **OR** Board closed it)
   - **Side-by-side with chat** — Computer panel alongside chat (Grok Bot–style split view; default when visible and both gates satisfied)
   - **Full screen** — Computer panel fills viewport (Board clicked "full screen" toggle; chat minimized or hidden)

**Acceptance:**
- **Gate behavior:** Computer tab is visible **only when both gates satisfied**:
  1. Company computer is provisioned (company-level gate)
  2. Agent `hasComputer === true` (agent-level gate; toolset alone does not satisfy)
- If company computer not provisioned, Computer tab is hidden regardless of agent config. Placeholder or warning: "Company Computer not provisioned. Enable at /settings/company-computer."
- If agent `hasComputer !== true`, Computer tab is hidden regardless of company config and toolset assignment. Placeholder or warning: "Agent does not have Computer access. Enable hasComputer in agent settings."
- Board chatting with agent (both gates satisfied) sees **Computer** tab in right panel (alongside Details/Media/other tabs)
- Tab labeled "{Agent name}'s screen" or similar
- Tab embeds noVNC client connected to agent's display on company computer
- Board sees agent's screen update in real-time (1-2 sec latency acceptable)
- Board can optionally click "Take Control" to send input (shared mouse/keyboard)
- Computer panel is contextual — shows the agent currently being chatted with
- Computer panel supports three layout modes: hidden (gates not satisfied or Board closed), side-by-side (default when visible), full screen
- Agent config (Overview, settings) is accessible but not the default landing view

**Test Gate (MVP-0 Implement):** Implement PRs that display Computer panel without verifying both gates (company provisioned AND agent hasComputer) will be HELD. The UI must check both conditions before showing noVNC embed. Spike/US-CC must document this gate so implementers inherit the constraint.

**"Done" for MVP-0:** 
- CC1 company provision (company-level gate) working on Demo/TEST metaspan
- CC2 browser (agent-level gate) → agent with `hasComputer` on provisioned company computer can open browser
- CC4 shell (agent-level gate) → agent with `hasComputer` can open terminal in `/home/{agentId}`
- Both gates enforced in code: company provision check + agent `hasComputer` check before allowing tool calls or UI display
- CC3 file manager and CC5 Board live view are natural on option A but not strict MVP-0 blockers (can be thinner/deferred)

---

## 6. Session Lifecycle

### Create Session

Triggered when an agent with `hasComputer === true` first calls a `computer*` tool:

1. **Verify company gate:** Check if company computer is provisioned (company settings or `company_computers` table). If not provisioned, return error: "Company Computer not provisioned. Ask Board to enable at /settings/company-computer."
2. **Verify agent gate:** Check if agent `hasComputer === true`. If not (false or null), return error: "Agent does not have Computer access. Ask Board to enable hasComputer on agent detail page." Toolset assignment alone does not satisfy this gate.
3. **Create agent home directory** (if not exists): `mkdir -p /home/{agentId}` with ownership `agent-{agentId}:agent-{agentId}` and permissions `0750`. Seed with `.bashrc`, `.bash_profile` templates.
4. Check if agent already has a display session (DB: `company_computer_sessions` table with `agentId`, `displayNumber`, `vncPort`, `pid`)
5. If no session, allocate next free display (`:10`, `:11`, …)
6. Start X server: `Xvnc :10 -geometry 1920x1080 -depth 24 -rfbport 5910 -SecurityTypes None -AlwaysShared` (runs as `agent-{agentId}` user, `HOME=/home/{agentId}`)
7. Start window manager: `DISPLAY=:10 HOME=/home/{agentId} xfce4-session &`
8. Record session in DB: `{ agentId, displayNumber: 10, vncPort: 5910, pid, homeDirectory: '/home/{agentId}', createdAt }`
9. Return session handle to agent tool

**Ordering constraint:** Company computer must be provisioned (step 1) before any agent homes are created (step 3). Implementation must enforce this ordering in code.

### Resume Session

When agent calls `computer*` tool and session exists:

1. Look up session from DB by `agentId`
2. Verify VNC process still running (check `pid`)
3. If dead, clean up stale DB row and create new session
4. If alive, return existing session handle

### Destroy Session

Triggered by Board action, agent calls `computerCloseSession()`, or agent `hasComputer` disabled:

1. Kill VNC server process (`kill $pid`)
2. Kill window manager and all child processes (`pkill -TERM -s $sessionId`)
3. Clean up `/tmp/.X10-lock` and display socket
4. Delete session row from DB

**Agent home directory teardown** (when agent `hasComputer` is disabled):
- **Safe option (recommended):** Archive `/home/{agentId}` to `/archive/{agentId}-{timestamp}.tar.gz` on company computer or S3. Remove from active filesystem. Board can restore if needed.
- **Destructive option:** Delete `/home/{agentId}` entirely (data loss; acceptable if explicitly documented in UI with confirmation dialog).
- **Implementation choice:** Document chosen semantics in `packages/company-computer/` README and UI warning text.

**Company computer deprovision cascade:**
- When company computer is deprovisioned (Board action at `/settings/company-computer`), all agent sessions are destroyed and all `/home/{agentId}` directories are archived or deleted according to chosen teardown semantics.
- Board must confirm: "Deprovisioning will archive/delete all agent homes. Proceed?" before executing.
- Activity log entry: "Company Computer deprovisioned. N agent homes archived to /archive/company-{companyId}-{timestamp}.tar.gz."

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

**MVP-0:** No hibernate. All sessions stay active. Board can destroy unused sessions via `/settings/company-computer` dashboard.

### Multi-Agent Concurrency

**One host, N agent sessions:**
- Display `:10` for agent A (urlKey `ceo`)
- Display `:11` for agent B (urlKey `cto`)
- Display `:12` for agent C (urlKey `eng-001`)

Each display is isolated (separate framebuffer, input queue, window list). Agents cannot see each other's screens unless they screenshot the host's `/tmp/.X11-unix/` sockets (which is intentionally blocked by filesystem permissions).

**Concurrency limit:** Start with N=10 max sessions per company (metaspan TEST limit). After 10 agents have active sessions, 11th agent tool call returns error: "Company Computer capacity exceeded. Ask Board to destroy idle sessions."

---

## 7. Ops Risks — Required Mitigation Plan

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
- **Board override:** Board can destroy any session from `/settings/company-computer` regardless of idle time.
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

## 8. Egress

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

## 9. Board Live View

### UI Integration

**UX Lock (Derek/PM 2026-09-30):**  
Board views Company Computer **from the Tourbillon web app while chatting to the agent**. Right-hand (or equivalent) **Computer** tab next to chat (alongside Details/Media/other tabs), showing that agent's GUI session (browser + file manager + shell), labeled e.g. "**{Agent name}'s screen**". Same feel as Grok Bot Details/Media/Computer. This is the **chat-adjacent Computer panel** for option A (noVNC/Selkies embed).

**Agent Detail Screen Defaults (Derek/PM 2026-09-30):**
1. **Default view = chat** — When Board navigates to an agent, they land in chat view first (not Overview/config)
2. **Agent config is secondary** — Overview, settings, capabilities accessible via navigate/modal/popup off chat default (not primary chrome)
3. **Computer panel layout options:**
   - **Hidden** — Computer tab not visible when **either gate fails** (company computer not provisioned **OR** agent `hasComputer !== true`) or Board manually closed it
   - **Side-by-side with chat** (default when visible) — Computer panel in right area alongside chat (Grok Bot–style split; both visible)
   - **Full screen** — Computer panel fills viewport (Board toggled full screen; chat minimized/hidden)

**Location:** **Computer** tab in right panel when chatting with agent (contextual to current agent conversation)

**NOT:** Separate standalone page at `/agent/{urlKey}/computer`. The Computer view is embedded in the chat UI, not a separate navigation destination.

**Label:** "{Agent name}'s screen" or "{Agent urlKey}'s desktop" — makes it clear whose GUI session is being viewed.

**Embed:** iframe or native noVNC client JavaScript:

```html
<!-- Simplified example -->
<div id="computer-panel" class="chat-adjacent-tab">
  <h3>CEO's screen</h3>
  <div id="vnc-container">
    <canvas id="vnc-canvas"></canvas>
  </div>
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

**MVP-0 thinner version:** Computer tab may initially be "screenshot refresh" mode (Board clicks Refresh → agent's latest `computerScreenshot()` displayed as static image) rather than full noVNC live stream. Full live-stream with noVNC is the product goal, but MVP-0 can ship with simpler "screenshot preview" if noVNC WebSocket proxy is not ready.

### Watch, Takeover, and Concurrent Access (Product Lock 2026-09-30)

#### 1. Default: Watch-Only (Non-Blocking)

**Watch mode (default):**
- Board sees agent's screen in real-time via noVNC embed in Computer tab
- Board **cannot** send input (mouse/keyboard blocked at VNC client or proxy)
- Agent is unaware Board is watching (no notification, no performance impact)
- **Watch-only never blocks the agent** — agent `computer*` tools continue executing regardless of Board viewers

**Multiple concurrent viewers:**
- Multiple Board members can watch the same agent's DISPLAY simultaneously (one-to-many VNC)
- Each viewer sees the same screen (agent's DISPLAY `:10`, `:11`, etc.)
- Viewers are **not** shared across agents (Board watching agent A does not see agent B's screen)

**Agent-side behavior:**
- Agent heartbeat continues normally
- Computer tools (`computerClick`, `computerTypeText`, etc.) execute immediately
- No waiting for Board approval or viewer presence

#### 2. Takeover Protocol (Teach-by-Showing / 2FA)

**Takeover flow:**
1. Board clicks **"Take Over"** button in Computer tab → sends `take_over` command to backend
2. Backend pauses **computer tools only** for that agent (agent's `computer*` tool calls return `{ paused: true, message: "Board has taken over. Waiting for hand-back..." }`)
3. Agent **heartbeat and non-computer tools continue** (e.g., `getInbox`, `updateIssue`, `addComment` still work; only computer tools block)
4. Board VNC client switches to input-enabled mode (`viewOnly: false`)
5. Agent desktop shows notification: **"Board member {name} is controlling. Waiting for hand-back."**
6. Board performs task (e.g., 2FA login, demonstrate workflow, fix stuck UI)
7. Board clicks **"Hand Back"** button → sends `hand_back` command
8. Backend unpauses computer tools for that agent
9. Agent desktop notification clears; agent tools resume

**Dual-drive constraint:**
- **No free dual-control in MVP** — Board input is off by default until takeover
- During takeover, agent tool calls to `computerClick` / `computerTypeText` are paused (return `paused: true`)
- If agent heartbeat is waiting on a computer tool result (e.g., "click OK button then read response"), the heartbeat blocks until hand-back
- If agent heartbeat is not waiting on computer tools (e.g., planning next step, reading comments), it continues normally

**Takeover timeout:**
- Timeout measured as **idle since last Board keypress or mouse move/click** on the authenticated VNC client (not wall-clock since takeover)
- Ignore VNC viewer heartbeats / cursor-sync noise (only real user input resets idle timer)
- Soft warning before auto hand-back: "Idle for 2 minutes. Handing back in 30 seconds unless you interact."
- Auto hand-back after idle timeout → same as Board clicking "Hand Back" (unpauses agent tools)

**Use cases:**
- **2FA / login secrets:** Board takes over, types credentials on live view, hands back. Agent never sees credentials in transcript or chat.
- **Teach-by-showing:** Board demonstrates workflow (e.g., navigate admin dashboard, fill form), agent observes and learns.
- **Unstick agent:** Agent clicks wrong button or gets stuck in modal; Board takes over, fixes, hands back.

#### 3. Tools and Protocol

**Computer toolset additions for takeover:**

| Tool | Parameters | Returns | Description |
|---|---|---|---|
| `screenView` | — | `{ vncUrl, status: 'watching' \| 'taken_over' }` | Get current VNC URL and takeover status. Agent can check if Board has control before attempting computer tool. |
| `takeOver` | `reason?: string` | `{ success: boolean }` | **Board-only tool** (not agent). Pauses agent computer tools, enables Board input. Reason logged to activity log. |
| `handBack` | — | `{ success: boolean }` | **Board-only tool** (not agent). Unpauses agent computer tools, disables Board input. |

**Screenshot tool behavior:**
- `computerScreenshot()` is **not paused** during takeover (agent can still screenshot to observe what Board is doing)
- Agent can call `screenView()` to check takeover status before attempting other computer tools

**Protocol state machine:**

```
Initial state: watching (Board sees screen, agent drives)
 → Board clicks "Take Over" → taken_over (Board drives, agent computer tools paused)
 → Board clicks "Hand Back" or idle timeout → watching
```

**Implementation notes:**
- noVNC RFB connection with `viewOnly: true` (watching) or `viewOnly: false` (taken_over)
- WebSocket proxy enforces mode based on takeover state stored in `company_computer_sessions` table (`takeoverStatus`, `takeoverBoardUserId`, `takeoverIdleSince`)
- Agent tool calls check `takeoverStatus` before executing; return `{ paused: true }` if taken over
- Backend resets idle timer on VNC input events (keypress, mouse move/click) from authenticated Board session

#### 4. Secrets and Credential Handling

**Never type credentials through agent chat/transcript:**
- Board must **not** instruct agent to type passwords, API keys, 2FA codes in chat
- Board must **not** paste secrets into issue comments or agent instructions
- **Correct flow:** Board takes over, types credentials directly on live VNC view, hands back
- Agent transcript remains clean (no secret leakage in observability, logs, or comments)

**Use case: 2FA login**
1. Agent opens browser to login page, enters username, sees 2FA prompt
2. Agent calls `screenView()` → returns `{ status: 'watching' }` (no takeover yet)
3. Agent comments: "Login requires 2FA. Board, please take over to complete."
4. Agent waits (heartbeat can continue with other tasks or polls `screenView()` status)
5. Board sees comment, clicks "Take Over" in Computer tab
6. Board types 2FA code, completes login, clicks "Hand Back"
7. Agent calls `screenView()` → returns `{ status: 'watching' }` (takeover released)
8. Agent continues workflow (scrapes data, fills form, etc.)

---

---

## 10. Agent Tools — New Tourbillon Toolset

**Toolset name:** `company-computer` (optional, see note)

**Gating (Two Gates):**
1. **Agent gate:** Agent `hasComputer === true` (required for home directory and session creation). The `company-computer` toolset does **not** bypass this gate.
2. **Company gate:** Company computer is provisioned (company settings or `company_computers` table row exists for `companyId`)

**Both gates must be satisfied** for tool calls to succeed. If company gate not satisfied, tool calls return: "Company Computer not provisioned. Ask Board to enable at /settings/company-computer." If agent gate not satisfied (hasComputer !== true), tool calls return: "Agent does not have Computer access. Ask Board to enable hasComputer on agent detail page."

**Toolset relationship (implementation choice):** If `company-computer` is implemented as a Tier 2 boolean toolset, it may control which Computer tools are available to the agent (e.g., browser vs terminal vs file manager), but it does **not** create `/home/{agentId}` or bypass the `hasComputer` gate. Home provisioning and Computer access are gated solely by `hasComputer === true`. Alternatively, implementation may skip the toolset entirely and gate all Computer tools directly via `hasComputer` field (simpler model).

**Tools** (Computer capabilities):

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

## 11. Non-Goals

### Not in MVP-0

- **Per-agent VMs:** One VM per company, not per agent. Agents share compute but have isolated display sessions. Per-agent VMs may be post-MVP for high-security companies (too expensive for MVP).
- **Bwrap-as-desktop:** Do not repurpose LocalSandbox bwrap for GUI isolation. Bwrap is for ephemeral process sandboxing; Company Computer is for durable GUI sessions. Architecture mismatch.
- **Managed desktop SaaS:** Do not bind to third-party SaaS (Windows 365, Amazon WorkSpaces, etc.) in MVP. Self-hosted Linux VM only. SaaS may be post-MVP for compliance-heavy customers.
- **Separate desktop-only page:** Computer view is **not** a standalone page at `/agent/{urlKey}/computer`. It is a **chat-adjacent tab** (right panel) visible while chatting with the agent. Product intent: Board watches agent's screen in the same UI where they chat, not a separate navigation destination.
- **TEST auto-deploy:** This spike/PR does **not** enable Company Computer on tourbillon-test.example.com. No runtime changes that pull to TEST without explicit Derek approval. This is docs-only.
- **Session recording:** No built-in session replay (à la Kasm) in MVP. Board can screen-record via browser if needed. Audit logs are post-MVP compliance feature.
- **GPU acceleration:** No GPU passthrough or Selkies in MVP. noVNC software rendering sufficient for CC1-CC4 stories. GPU is post-MVP for media-heavy tasks.
- **Mobile Board view:** noVNC embed works on desktop only. Mobile browser support is post-MVP (touch → mouse translation is poor UX without native app).

---

## 12. Open Questions for Ops/Derek

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

## 13. Next Steps

### Phase 1: Spike Review (This PR)

- [ ] Derek/PM reviews this spike doc
- [ ] Ops reviews Risks §7 and Open Questions §12
- [ ] Board/agent team reviews user stories §5
- [ ] Lock MVP scope: CC1 provision → CC2 browser → CC4 shell only

### Phase 2: Proof-of-Concept (Separate Branch)

- [ ] Implement company-level provisioning gate (company settings + DB schema for `company_computers` or `companies.computerEnabled`)
- [ ] Provision single Ubuntu VM on metaspan TEST with XFCE + x11vnc (company-level provision flow)
- [ ] Implement agent-level home creation gate (agent `hasComputer` config + `/home/{agentId}` creation on first tool call)
- [ ] Implement `computerOpenBrowser` + `computerScreenshot` tools with two-gate verification
- [ ] Test: Company provisioned → agent with `hasComputer` calls `computerOpenBrowser('https://example.com')`, takes screenshot, includes in issue comment
- [ ] Test: Company not provisioned → agent with `hasComputer` calls tool → receives "Company Computer not provisioned" error
- [ ] Test: Agent `hasComputer` disabled → agent calls tool → receives "Agent does not have Computer access" error
- [ ] Validate cgroup RAM/CPU caps work (manually stress-test with 5 concurrent agent sessions)

### Phase 3: MVP Implementation (POST This PR)

- [ ] New package: `packages/company-computer/` (session manager, VNC proxy, cgroup setup, home directory management)
- [ ] DB migration: `company_computers` table (company-level provisioning state) + `company_computer_sessions` table (agent sessions)
- [ ] DB migration: `agents.hasComputer` field (agent-level gate, required for home creation; toolset does not bypass)
- [ ] Computer tools: Implement in `role-tools.ts` or control-plane with two-gate verification (company provisioned + agent `hasComputer === true`). Toolset (if used) may control tool availability but does not bypass `hasComputer` gate.
- [ ] API routes: `/api/internal/company-computer/*` (all routes verify both gates before proceeding)
- [ ] API routes: `/api/settings/company-computer` (provision, deprovision, status check)
- [ ] Skill file: `company-computer-skills.md` (documents two-gate model and error messages)
- [ ] UI: Computer tab on agent detail page (chat-adjacent, hidden when gates not satisfied, shows noVNC embed when gates satisfied)
- [ ] UI: `/settings/company-computer` dashboard (provision/deprovision with confirmation, session list, resource usage, agent home status)
- [ ] UI: Agent detail page — "Computer Access" checkbox or toggle (agent-level gate) with warning about data loss on disable
- [ ] Ops: Terraform/Ansible to provision company VMs with cgroups + quotas + agent home directory structure
- [ ] Docs: Update AGENTS.md with Company Computer toolset, two-gate model, and architecture

### Phase 4: TEST Validation (HOLD Until Derek Approval)

- [ ] Deploy to tourbillon-test.example.com
- [ ] Create test company "Demo Corp"
- [ ] **Gate Test 1 (Company Gate):** Verify company computer not provisioned → agent tool calls fail with clear error
- [ ] **Gate Test 2 (Company Provision):** Provision company computer for Demo Corp via `/settings/company-computer`
- [ ] Create test agent "TestBot" with `hasComputer === true` enabled
- [ ] **Gate Test 3 (Agent Gate):** Create second agent "TestBot2" with `hasComputer` disabled (false or null) → verify tool calls fail with clear error, Computer tab hidden (even if toolset assigned)
- [ ] **Gate Test 4 (Both Gates Satisfied):** TestBot (hasComputer enabled, company provisioned) assigns issue: "Research Tourbillon competitors via Google"
- [ ] TestBot calls `computerOpenBrowser`, searches, screenshots results, posts to issue
- [ ] Verify `/home/testbot` directory exists on company computer with correct permissions
- [ ] Board watches TestBot's desktop via noVNC live view (Computer tab visible in chat UI)
- [ ] **Gate Test 5 (Cascade):** Disable TestBot `hasComputer` → verify session destroyed, `/home/testbot` archived/deleted
- [ ] **Gate Test 6 (Cascade):** Deprovision company computer → verify all sessions destroyed, all agent homes archived
- [ ] Validate cgroup limits (create 10 agents with `hasComputer`, stress-test RAM/CPU)
- [ ] Validate idempotent provision (re-provision company computer, verify existing agent homes preserved or warned about)

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
  - **Company Computer (`hasComputer` field):** Durable per-company GUI environment, agent display sessions, X11/VNC. Home creation gated by `hasComputer` field (not toolset).

- **Tourbillon architecture:** See `docs/architecture.md` for system overview, tool tiers, agent identity, wake loop.

- **Agent toolsets:** See AGENTS.md § Tool Tiers for how `assignedToolsets` gates Tier 2 boolean toolsets like `code-execution`, `web-search`, `comments`. If `company-computer` is implemented as a toolset, it may control tool availability but does **not** gate home creation — that requires `hasComputer === true`.

---

## Document Metadata

- **Author:** Tourbillon Agent (spike generation)
- **Reviewer:** Derek (PM/Ops), Board
- **Created:** 2026-09-30
- **Status:** DRAFT for review — no implementation yet
- **Epic:** Company Computer MVP (CC1 → CC2 → CC4)
- **Gating:** HOLD per-agent VMs, HOLD bwrap-as-desktop, ACCEPT draft spike only
