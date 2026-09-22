# Auth Smoke Testing Stories — TOUR-210

**Document Version**: 1.0  
**Last Updated**: 2026-09-22  
**Status**: Draft — Pending Product Implementation & Test Acceptance

---

## Context

This document defines user stories and acceptance criteria to unblock live authentication smoke testing on the TEST environment after PR #43 (allowNetwork) merged.

### Related Links

- **Goal**: `f486c37c` — Live auth smoke tests implementation
- **Issues**: TOUR-208, TOUR-210
- **PR**: #43 (allowNetwork support + TestSuper agent setup)
- **Agent**: TestSuper (specialized QA agent with network access)

### Current State (TEST Environment — 22 Sep 2026)

Ops-verified facts on TEST main:

1. **Auth endpoints missing**: `POST /api/auth/login` and `GET /api/auth/session` return **404**
   - These endpoints exist in workspace copies elsewhere but are not deployed to TEST main
2. **No persistent user storage**: Postgres has no users/auth tables; old `/tmp/tourbillon_users.json` absent
3. **Network capability available, not yet enabled**: PR #43 merged allowNetwork capability + TestSuper setup documentation
   - Agent sandbox defaults to deny (LocalSandbox); Ops has **not** hired TestSuper or flipped allowNetwork yet
   - Hire and allowNetwork flip deferred until US-A1–A5 ready + PM/Test approval (US-A6)
   - Host already reaches `metaspan` and `127.0.0.1:3002`; prefer `localhost` for smoke tests
4. **Security constraints in place**: Credentials MUST NOT appear in agent SOUL, instructions, issue bodies, chat, or git

### Desired Ops Sequence (Post-Product-Ship)

Derek's requested workflow after product implementation:

1. Ship `/api/auth/login` + `/api/auth/session` to TEST
2. Create a throwaway TEST user account
3. Store email/password in a mode-600 host file on tourbillon-test (e.g., `~/tourbillon/.env.test-auth`) for TestSuper to source
4. Hire TestSuper and enable `allowNetwork` (after US-A6 gate approval)
5. Run `projects/auth-smoke-tests.sh` with `TEST_API_BASE=http://127.0.0.1:3002`

---

## Track A — P0 Stories (Unblock TOUR-208 / TOUR-210)

These stories are **required** before TestSuper can execute live auth smoke tests on TEST. Test gates at the Accept level define what Test will verify before signing off.

---

### US-A1: Auth API Endpoints Available on TEST

**As** Ops  
**I want** `POST /api/auth/login` and `GET /api/auth/session` deployed and reachable on TEST  
**So that** TestSuper can execute auth smoke tests against live endpoints

#### Acceptance Criteria

- [ ] **AC-A1.1**: `POST /api/auth/login` endpoint exists and does not return 404 on TEST
  - Request contract documented: `{ email: string, password: string }`
  - Success response shape: `{ success: boolean, sessionId?: string, userId?: string, error?: string }`
  - Status codes: 200 (success), 401 (bad credentials), 400 (malformed request)

- [ ] **AC-A1.2**: `GET /api/auth/session` endpoint exists and does not return 404 on TEST
  - Request contract: Accepts session cookie or `Authorization: Bearer <token>` header
  - Success response shape: `{ authenticated: boolean, user?: { id: string, email: string }, error?: string }`
  - Status codes: 200 (session exists), 401 (no session or invalid)

- [ ] **AC-A1.3**: Endpoints are integrated with the application's routing and middleware
  - No 404, 500, or missing route errors on TEST deployment
  - Response bodies match documented contract

- [ ] **AC-A1.4**: Documentation or API contract is available
  - If schema differs from above, document actual request/response shapes in this story or in companion API docs

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Deploy verification** | Manual `curl` to TEST confirms 200 or 401 (not 404) | Ops |
| **Contract accuracy** | Response shapes match documented contract | Test Lead |
| **No regressions** | Existing TEST functionality unchanged | Ops + Test |

#### Out of Scope

- Production auth hardening
- Multi-tenancy or role-based access control beyond basic login
- Session expiration logic (acceptable if missing for smoke purposes)

---

### US-A2: Persistent User Storage on TEST

**As** Ops  
**I want** users and auth session data to persist in TEST Postgres (or chosen durable store)  
**So that** throwaway test accounts survive server restarts and smoke tests are repeatable

#### Acceptance Criteria

- [ ] **AC-A2.1**: Users table exists in TEST Postgres schema
  - Minimum fields: `id`, `email`, `password_hash`
  - Schema documented in migration or schema file

- [ ] **AC-A2.2**: Auth sessions or tokens are persistable
  - Either a sessions table, or stateless JWT signing secret configured
  - Sessions survive TEST app restart

- [ ] **AC-A2.3**: No reliance on ephemeral file storage like `/tmp/tourbillon_users.json`
  - Old file-based storage removed or ignored

- [ ] **AC-A2.4**: Users can be created via seed script, migration, or API
  - Mechanism documented for Ops to create throwaway test user

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **DB schema check** | `psql` inspection confirms users table exists | Ops |
| **Restart survivability** | Create user, restart TEST app, login succeeds | Test Lead |
| **No file deps** | `/tmp/tourbillon_users.json` absent or unused | Ops |

#### Out of Scope

- Password reset flows
- Email verification
- Multi-factor authentication
- User management UI

---

### US-A3: Throwaway TEST User Account

**As** Ops  
**I want** a mechanism to create one non-production user for smoke testing only  
**So that** TestSuper has valid credentials without touching production data

#### Acceptance Criteria

- [ ] **AC-A3.1**: Ops (or seed script) can create a user with email + password
  - Example email: `testsuper@example.com` (fake domain, not deliverable)
  - Password: random, mode-600 stored, never committed

- [ ] **AC-A3.2**: User creation is idempotent or skippable
  - Running seed/script twice does not error if user already exists

- [ ] **AC-A3.3**: User is isolated to TEST environment
  - No production database pollution
  - Email domain clearly marked as test (e.g., `@example.com`, `@test.local`)

- [ ] **AC-A3.4**: Documentation specifies who creates the user
  - Seed script path or manual SQL/API call steps
  - Credentials managed by Ops, never committed to git

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **User created** | Login succeeds with test credentials | Ops |
| **Idempotency** | Re-run seed script, no errors | Ops |
| **No git leakage** | Credentials never in git history | Test Lead |

#### Out of Scope

- User deletion or cleanup automation
- Multiple test users (one is sufficient for smoke)

---

### US-A4: Credential Delivery to TestSuper (Interim)

**As** Ops  
**I want** a mode-600 host file on tourbillon-test for TestSuper to source credentials  
**So that** smoke tests can authenticate without embedding passwords in prompts or git

#### Acceptance Criteria

- [ ] **AC-A4.1**: Host file path documented
  - Example: `~/tourbillon/.env.test-auth`
  - Permissions: mode 600 (owner read/write only)

- [ ] **AC-A4.2**: Host file contains required environment variables
  ```bash
  TEST_EMAIL=testsuper@example.com
  TEST_PASSWORD=<random-from-ops>
  TEST_API_BASE=http://127.0.0.1:3002  # optional, default if omitted
  ```

- [ ] **AC-A4.3**: TestSuper smoke script sources the host file
  - Example: `set -a && source ~/tourbillon/.env.test-auth && set +a`
  - Script exits with error if file missing or unreadable

- [ ] **AC-A4.4**: Explicitly FORBIDDEN paths for credentials
  - ❌ Agent SOUL.md or instructions
  - ❌ Issue bodies or comments
  - ❌ Chat or Board approval text
  - ❌ Git repository (any branch, any file)

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **File mode check** | `ls -l` shows 600 on tourbillon-test | Ops |
| **Script sources** | Smoke script reads vars without hardcoding | Test Lead |
| **No leakage** | Grep for password string in git, prompts, comments = empty | Test Lead |

#### Out of Scope

- Vault or secrets-manager integration (Track B)
- Per-agent secrets/variables (Track B, US-B1)

---

### US-A5: Auth Smoke Test Script

**As** Test Lead  
**I want** a `projects/auth-smoke-tests.sh` script that validates login and session endpoints  
**So that** TestSuper can execute repeatable smoke tests with clear pass/fail

#### Acceptance Criteria

- [ ] **AC-A5.1**: Script location and name
  - Path: `projects/auth-smoke-tests.sh`
  - Executable: `chmod +x projects/auth-smoke-tests.sh`

- [ ] **AC-A5.2**: Script accepts `TEST_API_BASE` environment variable
  - Default: `http://127.0.0.1:3002` (localhost on tourbillon-test host)
  - Override example: `TEST_API_BASE=http://tourbillon-test.metaspan.com`

- [ ] **AC-A5.3**: Script checks (minimum)
  1. **Login succeeds**: `POST /api/auth/login` with valid credentials returns success (200 or 201)
  2. **Session returns authenticated user**: `GET /api/auth/session` with session cookie/token returns `authenticated: true`
  3. **Wrong password fails cleanly**: `POST /api/auth/login` with bad password returns 401
  4. **Credentials never printed**: Script output does not echo `TEST_PASSWORD` or tokens in plain text

- [ ] **AC-A5.4**: Exit codes
  - Exit 0: All checks passed
  - Exit 1: At least one check failed (with descriptive error)

- [ ] **AC-A5.5**: Output format
  - Structured for parsing by TestSuper
  - Example:
    ```
    Check 1: Login with valid credentials ... PASS
    Check 2: Session endpoint authenticated ... PASS
    Check 3: Login with wrong password fails ... PASS
    All checks passed.
    ```

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Script runs locally** | Ops can execute on tourbillon-test, exits 0 | Ops |
| **Checks cover AC-A5.3** | Script validates login, session, bad password, no leaks | Test Lead |
| **Localhost preference** | Default `TEST_API_BASE` is `127.0.0.1:3002` | Test Lead |

#### Implementation Note

This story defines the **behavior** of `projects/auth-smoke-tests.sh`. The script itself can be added in this PR as a stub or placeholder, or in a follow-up implementation PR. If stubbed here, the stub should:
- Exist at `projects/auth-smoke-tests.sh`
- Echo `echo "Smoke test script placeholder — implement per AC-A5"`
- Exit 0 (so it doesn't block PR merge)

Full implementation follows when US-A1 through US-A4 are complete.

---

### US-A6: TestSuper Hire Gate

**As** PM / Test Lead  
**I want** explicit readiness gates before TestSuper is hired or `allowNetwork` is enabled  
**So that** we don't prematurely expose network access before smoke prerequisites are met

#### Acceptance Criteria

- [ ] **AC-A6.1**: TestSuper is NOT hired (or remains paused) until US-A1 through US-A5 are complete
  - If TestSuper already exists (from PR #43), heartbeats remain paused or timer inactive

- [ ] **AC-A6.2**: Ops holds the host file (`~/tourbillon/.env.test-auth`) until PM/Test says go
  - File is created only after throwaway user (US-A3) exists
  - Credentials sourced from secure Ops storage, never from chat or git

- [ ] **AC-A6.3**: Documentation updated to reflect hire gate
  - `docs/test-super-agent-setup.md` notes: "Do not hire or enable heartbeats until US-A1–A5 ready + PM/Test approval"

- [ ] **AC-A6.4**: First smoke test execution is supervised
  - Ops or Test Lead observes first TestSuper wake with auth smoke
  - Results reviewed before unattended use

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Hire deferred** | TestSuper exists but paused OR not hired until go | PM + Ops |
| **Host file deferred** | `.env.test-auth` created only after go decision | Ops |
| **First run supervised** | Test Lead present for first live smoke execution | Test Lead |

#### Out of Scope

- Automated hire/pause logic based on deployment status
- CI/CD integration for smoke tests (future work)

---

## Track B — P1 / Optional Stories

These stories are **separate** from unblocking TOUR-208/TOUR-210. They represent future enhancements for credential management and security.

---

### US-B1: Per-Agent Secrets/Variables

**As** Ops  
**I want** a secret store scoped to an agent (e.g., TestSuper)  
**So that** test credentials can be managed via UI or API without host files or SOUL paste

#### Acceptance Criteria

- [ ] **AC-B1.1**: Agent settings UI includes a "Secrets" or "Environment Variables" section
  - Key/value pairs scoped to the agent
  - Values are write-only (not displayed after save)

- [ ] **AC-B1.2**: Secrets are available to the agent at runtime
  - Environment variables injected during code execution (e.g., `TEST_EMAIL`, `TEST_PASSWORD`)
  - Not visible in prompts, observability logs, or issue comments

- [ ] **AC-B1.3**: Ops or PM can set/rotate secrets without editing host files
  - UI form or API endpoint to update secrets
  - Changes take effect on next agent wake

- [ ] **AC-B1.4**: TestSuper smoke script can source from agent secrets
  - Fallback to host file if agent secrets not configured
  - Example:
    ```bash
    TEST_EMAIL="${TEST_EMAIL:-$(grep TEST_EMAIL ~/.env.test-auth | cut -d= -f2)}"
    ```

#### Quality Gates (Optional — Track B)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **UI smoke** | Secrets can be set and read at runtime (not in logs) | Test Lead |
| **Rotation** | Update secret, agent sees new value on next wake | Ops |
| **Backward compat** | Host file still works if secrets not configured | Ops |

#### Out of Scope for B1

- Company-wide secrets (scoped to all agents)
- Integration with external vaults (HashiCorp Vault, AWS Secrets Manager)
- Secret versioning or audit logs

---

## Quality Gates Summary

| Story | Gate | ACCEPT Condition | HOLD Condition |
|-------|------|------------------|----------------|
| **US-A1** | Deploy | Auth endpoints live on TEST, not 404 | 404 or 500 on TEST |
| **US-A2** | Schema | Postgres users table exists | No persistent storage |
| **US-A3** | User exists | Login with test creds succeeds | User creation fails |
| **US-A4** | File mode | `~/.env.test-auth` mode 600, no git leaks | Credentials in git or prompts |
| **US-A5** | Script runs | Exit 0, checks AC-A5.3 pass | Script missing or fails |
| **US-A6** | Supervision | First smoke supervised, PM/Test approve | TestSuper hired prematurely |
| **US-B1** | Optional | Secrets UI works, runtime injection OK | N/A (Track B is P1, not blocker) |

---

## Out of Scope (All Tracks)

The following are explicitly **not** in scope for TOUR-208/TOUR-210 or this documentation PR:

1. **Production auth hardening**
   - Rate limiting, password complexity, session expiration beyond basic smoke
2. **Giving non-TestSuper agents network access**
   - `allowNetwork: true` remains exclusive to TestSuper
3. **Merging unrelated draft PRs or features**
   - This PR is docs-only; no product code changes
4. **Automated CI/CD smoke test runs**
   - Future work after manual smoke validates
5. **Real user onboarding or admin UI**
   - TEST user is throwaway, not a production feature
6. **External secrets vaults**
   - Track B (US-B1) covers in-app secrets; external vaults are separate future work

---

## Ops Sequence Checklist (Post-Product-Ship)

Derek's workflow, expanded with story references:

- [ ] **Step 1**: Verify US-A1 complete (auth endpoints deployed to TEST)
- [ ] **Step 2**: Verify US-A2 complete (Postgres users table exists)
- [ ] **Step 3**: Verify US-A3 complete (throwaway user created)
  - Example: `testsuper@example.com` with random password
- [ ] **Step 4**: Verify US-A4 complete (create `~/tourbillon/.env.test-auth`, mode 600)
  - Populate `TEST_EMAIL`, `TEST_PASSWORD`, optionally `TEST_API_BASE`
- [ ] **Step 5**: Verify US-A5 complete (`projects/auth-smoke-tests.sh` exists and passes manual run)
  - Run: `TEST_API_BASE=http://127.0.0.1:3002 ./projects/auth-smoke-tests.sh`
  - Expect: Exit 0, all checks PASS
- [ ] **Step 6**: Verify US-A6 complete (PM/Test approval to proceed)
- [ ] **Step 7**: Enable TestSuper heartbeats (if paused) or hire TestSuper (if not yet created)
- [ ] **Step 8**: Assign first smoke test issue to TestSuper, observe execution (supervised)
- [ ] **Step 9**: Review results, sign off on TOUR-208/TOUR-210 acceptance

---

## Related Resources

- **AGENTS.md**: Tourbillon agent architecture and tool tiers
- **docs/test-super-agent-setup.md**: TestSuper agent configuration guide
- **packages/skills/test-super/SKILL.md**: TestSuper testing persona skill
- **PR #43**: allowNetwork support + TestSuper agent setup
- **Goal f486c37c**: Live auth smoke tests implementation goal

---

## Document Maintenance

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-09-22 | Docs PR (TOUR-210) | Initial draft with Track A (P0) and Track B (P1) stories |

---

**End of Document**
