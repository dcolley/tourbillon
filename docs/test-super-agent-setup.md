# TestSuper Demo Agent Setup

## Overview

**TestSuper** is a specialized testing agent configured with network access for running verification, smoke, and acceptance tests against named TEST environments. This agent is the **only** agent that should have `allowNetwork: true` enabled in code execution.

## Purpose

TestSuper exists to:
- Run verification tests against TEST deployment hosts
- Execute smoke tests that require live network connectivity
- Validate acceptance criteria that involve API calls to test environments
- Post test results as issue comments (never credentials)

## Security Constraints

### Strict Persona (MUST BE CONFIGURED)

TestSuper has a **mandatory system persona** that restricts its behavior:

```markdown
# TestSuper Agent Persona

You are TestSuper, a specialized testing agent. Your ONLY purpose is to run verification, 
smoke, and acceptance tests against authorized TEST environments.

## What You MAY Do
- Run tests against the following allowed hosts:
  - localhost and 127.0.0.1 (PREFERRED for smoke tests on tourbillon-test host)
  - tourbillon-test.metaspan.com
  - Any host explicitly named in TOURBILLON_TEST_HOSTS environment variable
- Execute test scripts located in the `projects/` directory
- POST/GET to allowed test hosts using credentials from environment variables
- Comment test results on issues (pass/fail, response times, error messages)
- Use code execution tools to run verification scripts

## What You MUST NOT Do
- NEVER browse the open web or access domains outside the allowed list
- NEVER exfiltrate secrets, credentials, or API keys in any form
- NEVER mutate production systems or databases
- NEVER push code to repositories
- NEVER use network for general research or web scraping
- NEVER execute arbitrary user requests outside of testing scope

## Behavior
- If asked to do anything outside testing scope, REFUSE and comment on the issue
- Always validate that target hosts are in the allowed list before making requests
- Prefer using pre-written test scripts (e.g., `projects/auth-smoke-tests.sh`)
- Report results as structured comments, never as raw credential dumps
- If credentials are missing from environment, comment that setup is incomplete
```

### Network Configuration

- **allowNetwork**: `true` (ONLY for this agent)
- **Isolation**: `bwrap` (Linux) or `seatbelt` (macOS) — required for network controls
- **Code execution toolset**: Enabled

## Setup Instructions

### Option 1: UI-Based Setup

**IMPORTANT**: Do NOT hire TestSuper or enable `allowNetwork` until all prerequisites are ready (see **Hire Gate** section below).

1. Navigate to `/dashboard/agent/new`
2. Configure agent:
   - **Name**: `TestSuper`
   - **URL Key**: `test-super` (or similar)
   - **Role**: `qa` or `custom`
   - **Model**: Same as other demo agents (e.g., `qwen2.5-3b-instruct` on vLLM-2)
3. Save agent, then navigate to agent detail page
4. **Instructions tab**:
   - Paste the strict persona above into **SOUL.md**
5. **Capabilities tab**:
   - Enable `code-execution` toolset
   - Assign `test-super` skill
6. **Code & execution tab**:
   - Ensure code execution is enabled
   - Set isolation to `bwrap` (Linux) or `seatbelt` (macOS)
   - **Check** "Allow network (sandbox)" — ONLY after PM/Test approval (see Hire Gate)
7. **Heartbeats tab**:
   - Start **paused** or set timer to inactive until smoke prerequisites complete
   - Enable "Wake on assignment" after hire gate passed

### Option 2: Seed Script (Future)

A seed script or migration can be added to programmatically create TestSuper with these settings:

```typescript
// Example seed logic (not yet implemented)
const testSuper = await createAgent({
  name: 'TestSuper',
  urlKey: 'test-super',
  role: 'qa',
  companyId: demoCompanyId,
  instructionsBundleSoulMd: TEST_SUPER_PERSONA,
  codeExecutionEnabled: true,
});

await updateAgentCodeExecution(testSuper.id, {
  runtimeType: 'agent',
  codeExecutionEnabled: true,
  isolation: 'bwrap', // or 'seatbelt' on macOS
  allowNetwork: true,
});
```

## Environment Variables

TestSuper requires the following environment variables for test credentials:

```bash
# Preferred: Localhost for smoke tests on tourbillon-test host
TEST_API_BASE=http://127.0.0.1:3002

# Alternative: Remote TEST deployment
# TEST_API_BASE=https://tourbillon-test.metaspan.com

# Optional: Additional allowed hosts (comma-separated)
TOURBILLON_TEST_HOSTS=tourbillon-test.metaspan.com,localhost,127.0.0.1

# Auth smoke test credentials (NEVER committed to repo)
TEST_EMAIL=<from-ops>
TEST_PASSWORD=<from-ops>

# Legacy board approval credentials (if needed)
TEST_BOARD_USERNAME=<from-ops>
TEST_BOARD_PASSWORD=<from-ops>
```

**IMPORTANT**: Test credentials are managed by Ops and delivered via one of these methods:

### Credential Delivery (Interim — Track A)

**Preferred**: Mode-600 host file on tourbillon-test

```bash
# Path: ~/tourbillon/.env.test-auth
# Permissions: chmod 600 ~/tourbillon/.env.test-auth
TEST_EMAIL=testsuper@example.com
TEST_PASSWORD=<random-from-ops>
TEST_API_BASE=http://127.0.0.1:3002
```

TestSuper smoke scripts source this file:

```bash
set -a && source ~/tourbillon/.env.test-auth && set +a
./projects/auth-smoke-tests.sh
```

**FORBIDDEN**: Credentials in agent SOUL.md, instructions, issue bodies, chat, or git.

### Credential Delivery (Future — Track B)

**Planned**: Per-agent secrets/variables (US-B1 in `docs/stories-auth-smoke-tour-210.md`)
- Secrets scoped to TestSuper agent
- Set via UI or API, not host files
- Values injected at runtime, never visible in prompts or logs

## Hire Gate (CRITICAL)

**Do NOT hire TestSuper or enable `allowNetwork` until all of the following are ready:**

### Prerequisites (Track A — P0 Stories)

Reference: `docs/stories-auth-smoke-tour-210.md`

- [ ] **US-A1**: Auth API endpoints (`POST /api/auth/login`, `GET /api/auth/session`) deployed to TEST (not 404)
- [ ] **US-A2**: Postgres users/auth tables exist on TEST (persistent storage)
- [ ] **US-A3**: Throwaway TEST user created (e.g., `testsuper@example.com`)
- [ ] **US-A4**: Host file `~/tourbillon/.env.test-auth` created with mode 600, credentials populated
- [ ] **US-A5**: `projects/auth-smoke-tests.sh` script exists and passes manual run
- [ ] **US-A6**: PM and Test Lead approval to proceed

### Gate Enforcement

- **Before gate**: TestSuper remains paused (heartbeats disabled) OR not yet hired
- **At gate**: Ops holds host file, PM/Test review readiness
- **After gate**: Enable heartbeats, assign first smoke test issue (supervised)

### First Run Supervision

The first TestSuper wake with live auth smoke tests must be supervised by Ops or Test Lead:
1. Observe heartbeat execution in `/jobs`
2. Review issue comments for results
3. Confirm credentials not leaked in prompts or logs
4. Sign off on TOUR-208/TOUR-210 acceptance

## Usage

### Assigning Test Tasks

After hire gate passed, create an issue and assign it to TestSuper:

```markdown
**Title**: Run auth smoke tests for TOUR-208

**Description**:
Execute the auth smoke tests against TEST deployment:
1. Source credentials from `~/tourbillon/.env.test-auth`
2. Run `projects/auth-smoke-tests.sh`
3. Verify checks pass against http://127.0.0.1:3002 (preferred localhost)
4. Report pass/fail and any errors

**Acceptance Criteria**:
- [ ] Script exits with 0 (all checks pass)
- [ ] Login succeeds, session returns authenticated user
- [ ] Wrong password fails cleanly (401)
- [ ] Test results posted as comment (no credential leaks)
```

### Expected Behavior

When woken, TestSuper will:
1. Check out the issue
2. Validate that target hosts are in the allowed list
3. Execute the test script with network access
4. Post results as a structured comment:
   ```markdown
   ## Test Results
   
   **Script**: `projects/auth-smoke-tests.sh`
   **Exit Code**: 0
   **Duration**: 2.3s
   
   ### Checks
   - ✅ Check 1: Connection to tourbillon-test.metaspan.com succeeded
   - ✅ Check 2: Auth endpoint returned 200 OK
   
   All checks passed.
   ```

## Monitoring

- TestSuper heartbeats are logged in `/jobs` like other agents
- Code execution logs are written to the per-issue sandbox directory
- Network access is restricted by bwrap/seatbelt at the OS level
- If TestSuper attempts to access disallowed hosts, the sandbox will block it

## Troubleshooting

### TestSuper still gets EHOSTUNREACH

- Verify `allowNetwork: true` is persisted in agent `runtimeConfig.codeExecution`
- Check that isolation is NOT `none` — network control requires `bwrap` or `seatbelt`
- Confirm the target host is in the allowed list
- Check firewall rules on the host machine

### TestSuper refuses to run tests

- Ensure the strict persona is configured in **SOUL.md**
- Check that the task explicitly mentions "test" or "verification"
- Verify the issue includes an allowed host in its description

### Network is too permissive

- Default is `allowNetwork: false` for all agents
- TestSuper is the ONLY agent that should have `allowNetwork: true`
- Double-check that Engineer, CEO, CTO, and other agents have `allowNetwork` unset or `false`

## Related Resources

- **docs/stories-auth-smoke-tour-210.md**: User stories and acceptance criteria (Track A P0 + Track B P1)
- **TOUR-210**: Board approval gate for TEST credentials
- **TOUR-208**: Auth smoke test acceptance criteria
- **Goal f486c37c**: Live auth smoke tests implementation goal
- **PR #43**: allowNetwork support + TestSuper agent setup (merged)
- **packages/skills/test-super/SKILL.md**: TestSuper testing persona skill

## Security Notes

1. **Never commit TEST credentials** — use environment variables or secrets management
2. **TestSuper is the exception** — all other agents must remain `allowNetwork: false`
3. **Persona enforcement** — the strict system prompt is the primary safety control
4. **OS-level isolation** — bwrap/seatbelt provide defense-in-depth
5. **Audit logs** — all TestSuper network activity is logged in heartbeat runs

## Acceptance Tests

- [ ] TestSuper agent created with `allowNetwork: true`
- [ ] All other agents have `allowNetwork` unset or `false`
- [ ] TestSuper can reach `tourbillon-test.metaspan.com` from sandbox
- [ ] TestSuper persona refuses non-testing tasks
- [ ] UI toggle persists `allowNetwork` setting correctly
