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
  - tourbillon-test.metaspan.com
  - localhost and 127.0.0.1 (for local services)
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
6. **Code & execution tab**:
   - Ensure code execution is enabled
   - Set isolation to `bwrap` (Linux) or `seatbelt` (macOS)
   - **Check** "Allow network (sandbox)"
7. **Heartbeats tab**:
   - Start **paused** or set timer to inactive until DEMO hire is intentional
   - Enable "Wake on assignment" if tests will be assigned via issues

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
# Required: Test environment base URL
TOURBILLON_TEST_BASE_URL=https://tourbillon-test.metaspan.com

# Optional: Additional allowed hosts (comma-separated)
TOURBILLON_TEST_HOSTS=tourbillon-test.metaspan.com,localhost,127.0.0.1

# Board approval credentials (NEVER committed to repo)
TEST_BOARD_USERNAME=<from-ops>
TEST_BOARD_PASSWORD=<from-ops>

# Or use a token-based approach
TEST_AUTH_TOKEN=<from-ops>
```

**IMPORTANT**: Test credentials are managed by Ops and injected via environment or secrets management. They are **never** committed to the repository.

## Usage

### Assigning Test Tasks

Create an issue and assign it to TestSuper:

```markdown
**Title**: Run auth smoke tests for TOUR-208

**Description**:
Execute the auth smoke tests against TEST deployment:
1. Run `projects/auth-smoke-tests.sh`
2. Verify checks 1-2 can reach tourbillon-test.metaspan.com
3. Report pass/fail and any EHOSTUNREACH errors

**Acceptance Criteria**:
- [ ] Script exits with 0 (all checks pass)
- [ ] No EHOSTUNREACH errors logged
- [ ] Test results posted as comment
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

- **TOUR-210**: Board approval gate for TEST credentials
- **TOUR-208**: Auth smoke test acceptance criteria
- **Goal f486c37c**: Live auth smoke tests implementation goal
- **Board Approval 7731439a**: TEST credential approval (out of scope for this PR)
- **Execution Gate Addendum**: `resources/execution-gate-addendum-egress-2026-09-01.md` (if present)

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
