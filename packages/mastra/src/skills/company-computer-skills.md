# Company Computer skills (toolset: company-computer)

You have access to a per-agent GUI desktop seat (KasmVNC container) when BOTH gates are
open: your company has Computer enabled AND your agent has `hasComputer` enabled. The
toolset being attached does not bypass the gates — every call is checked server-side.

## When to use

- Pages that need real rendering: JS-heavy dashboards, login flows, visual verification.
- Prefer `web-search` / browser tools for plain research; prefer the code-execution
  sandbox for scripts. The desktop is for what truly needs a screen.

## Tools

| Tool | Purpose |
|---|---|
| `computerOpenBrowser(url?)` | Ensure your seat is up and open a URL |
| `computerScreenshot()` | Base64 PNG of your desktop — read the page, verify clicks |
| `computerClick(x, y, button?)` | Click absolute pixel coordinates |
| `computerTypeText(text)` | Type into the focused window |
| `computerGetSessionInfo()` | Seat status, ports, timestamps |
| `computerCloseSession()` | Tear the seat down when GUI work is done |

`computerOpenFileManager`, `computerOpenTerminal`, `computerPressKey`, `computerMouseMove`
and `computerScroll` are registered but return `not_implemented` in this slice.

## Discipline

- Work loop: open → screenshot → act → screenshot. Never click blind twice in a row.
- Check `computerGetSessionInfo()` before driving input to confirm the seat is running.
- Board watch/takeover of your seat is **Slice 2 — not available yet**. Nothing pauses
  your input in this slice; do not wait for or expect a `paused` result.
- NEVER type passwords, API keys, or 2FA codes. Comment on the issue and ask the Board
  to handle credential entry; the transcript must stay clean.
- Call `computerCloseSession()` when finished with GUI work to free host resources.
  Your home directory persists; the container does not.
- Gate errors are actionable, quote them verbatim:
  - "Company Computer not provisioned. Ask Board to enable at /settings/company-computer."
  - "Agent does not have Computer access. Ask Board to enable hasComputer on the agent detail page."
- While host provisioning is not yet enabled (Ops contract pending), seat creation and
  desktop actions return `host_start_refused` / `ops_contract_missing`. Do not retry in a
  loop — report the blocker in your comment and move on.
