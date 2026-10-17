# Browser toolset (`browser`)

Opt-in per agent, off by default (not in any role default). When an agent has the
`browser` toolset, its heartbeat Agent is built with a Mastra browser provider and gets
14 browser tools: `browser_goto`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_press`, `browser_select`, `browser_scroll`, `browser_close`, `browser_hover`,
`browser_back`, `browser_dialog`, `browser_wait`, `browser_tabs`, `browser_drag`.

- `browser_evaluate` (script evaluation in the page) is never exposed.
- `browser_screenshot` is opt-in per agent and off by default:
  `runtimeConfig.browser.screenshots: true`, set on the agent page → Capabilities →
  **Browser options → Screenshots** (shown when the toolset is ticked). Screenshots are PNG
  images and need a vision-capable model.
- Package: [`@mastra/agent-browser`](https://mastra.ai/integrations/browsers/agent-browser)
  `0.5.3` (pinned; peer `@mastra/core >=1.22 <2`, we run 1.75.0). It drives Chromium
  through `agent-browser` → `playwright-core`.
- Enable it on the agent page → Capabilities → **Browser (headless Chromium)**.
- Scope: heartbeat (wake) runs only. Dashboard chat and harness controllers do not get
  browser tools; chat and harness parity is a planned follow-up.

## Host prerequisite (Ops step — needs Derek's yes)

Chromium is not bundled. On the host that runs the scheduler, as the service user:

```bash
npx playwright install --with-deps chromium
```

`--with-deps` installs system packages (apt) and needs sudo. This is a separate Ops step:
do not run it as part of a deploy without Derek's explicit yes. Until it is done, an agent
with the toolset gets a launch error from the first browser tool call (the rest of the run
is unaffected).

Run the scheduler as a non-root user: Chromium's sandbox refuses to start as root and the
provider does not pass `--no-sandbox`.

Node: `@mastra/agent-browser` declares `engines.node >=22.13.0`; see the PR for the runtime check on Node 20.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `TOURBILLON_BROWSER_EXECUTABLE_PATH` | unset (Playwright's Chromium) | Chromium binary to launch |
| `TOURBILLON_BROWSER_STEP_TIMEOUT_MS` | `45000` (clamped 5000–120000) | Hard cap per browser tool call. On expiry the browser is closed and the tool returns `code: "timeout"`. |
| `TOURBILLON_BROWSER_NAV_TIMEOUT_MS` | `30000` (clamped 1000–step cap) | Navigation and in-page action timeout; the model cannot ask for more. |
| `AGENT_BROWSER_PROVIDER` | must stay unset | If set, the toolset is omitted (a cloud browser would bypass the egress guard). |

## Egress

Every URL the browser loads is checked (agent navigation, subresources, popups / new
tabs, WebSockets, and the `Location` of each redirect hop on navigations):

1. Only `http`/`https` (navigation may also use exactly `about:blank`). `file:`, `data:`,
   `javascript:`, `chrome:`, `view-source:` … are refused before Chromium is launched.
   URLs with a username or password are refused.
2. Outbound host allow-list: company `settings.toolEgressAllowList` and agent
   `runtimeConfig.toolEgressAllowList` (the tool egress lists from #141). Unset = no
   host restriction; set = the host must match every list that is set.
3. Local and internal addresses are always refused, whatever the lists say: loopback,
   RFC1918, CGNAT, link-local and cloud metadata, unique-local IPv6. Hostnames are
   resolved and every address is checked.

Denials are logged as `[browser] browser egress denied` with the host and reason only.

Stronger network enforcement at the browser process level (a filtering proxy plus a
custom thread manager) is a planned P1 follow-up. Until then, enforcement is at the
Playwright request layer described above.

## Cleanup

The browser is launched lazily on the first browser tool call and closed in the wake
runner's `finally` (success, error, abort, wall-clock timeout), bounded to 10 s.
