# Plugin Vault + MCP Credential Migration — P0 Slice

**Document Version**: 1.0  
**Last Updated**: 2026-09-26  
**Status**: Draft — Awaiting Product Implementation & Test Acceptance

---

## Context

This document defines the **P0 (Priority 0) slice** of Tourbillon's plugin architecture build: **vault + MCP credential migration**. This unblocks Dev implementation of a secure, scoped credential store to replace the current `settings.mcpCredentials` flat key-value store.

### Product Decisions (Locked)

1. **Plugins**: Install at company level → bind credentials → grant to select agents in agent config. **Install ≠ grant**. P0 scope: vault/credentials only; full `plugin.json` catalog + UI discovery is P1.
2. **Vault**: Secrets scoped `company` | `company_user` | `agent`; ciphertext **never** exposed to model/logs/UI after save.
3. **Auth**: Static API keys + OAuth with refresh; `needs_reauth` state on failure.
4. **Channels / email / self-inspect tools**: P2 — explicitly out of scope for this PR; mention only as future work.
5. **MCP**: Remains compatibility layer; plugins are the product unit later.

### Related Links

- **Goal issue**: [#52](https://github.com/dcolley/tourbillon/issues/52) — Plugin Vault + MCP Credential Migration (P0)
- **User story issues**: [#53](https://github.com/dcolley/tourbillon/issues/53) (US-V1), [#54](https://github.com/dcolley/tourbillon/issues/54) (US-V2), [#55](https://github.com/dcolley/tourbillon/issues/55) (US-V3), [#56](https://github.com/dcolley/tourbillon/issues/56) (US-V4), [#57](https://github.com/dcolley/tourbillon/issues/57) (US-V5), [#58](https://github.com/dcolley/tourbillon/issues/58) (US-V6), [#59](https://github.com/dcolley/tourbillon/issues/59) (US-V7)
- **Draft PR**: [#51](https://github.com/dcolley/tourbillon/pull/51)
- **Prior work**: Track B US-B1 (per-agent secrets) — merged and live in `runtimeConfig.secrets`
- **Repository**: https://github.com/dcolley/tourbillon
- **Related docs**: `docs/stories-auth-smoke-tour-210.md`, `AGENTS.md` (Tool Tiers)
- **Parked (out of scope)**: Human org-chart users

---

## Current State (Codebase — 2026-09-26)

### MCP Credentials Today

| Layer | Location | How it works |
|---|---|---|
| **Company-wide** | `companies.settings.mcpCredentials: Record<string, string>` | Flat key-value store; keys are MCP server IDs (e.g. `buffer-mcp`, `github-mcp`) |
| **Per-agent override** | `agents.runtimeConfig.mcpCredentials: Record<string, string>` | Agent-specific override; same flat structure |
| **Resolution** | `packages/shared/src/mcp-credentials.ts` `resolveMcpCredential()` | Cascade: agent runtime → company settings → `process.env[envVar]` → `null` |
| **UI (company)** | `apps/web/app/(dashboard)/settings/page.tsx` | Company-wide Buffer API key saved to `mcpCredentials['buffer-mcp']`; password input, write-only after save |
| **UI (agent)** | `apps/web/app/(dashboard)/agent/[urlKey]/page.tsx` → capabilities tab | Per-agent integration overrides (Tavily, Buffer, SearXNG) in `AgentCapabilitiesForm` |

**Existing MCP servers in use**:
- `buffer-mcp` — Buffer social publishing (official MCP)
- `github-mcp`, `tavily-mcp`, `searxng-mcp` — community/self-hosted

**Limitations**:
1. **No scopes**: Company vs. user vs. agent is implicit (no formal scope column).
2. **No OAuth support**: Only static API keys; no refresh token handling.
3. **Ciphertext not enforced**: Values are stored in JSONB; encryption at rest is Postgres-level (TDE) but not application-level field encryption.
4. **No `needs_reauth` state**: On failure (e.g. expired token), system retries or fails silently — no UI prompt to reconnect.
5. **Flat namespace**: `mcpCredentials` is just `{ [serverId]: string }` — no multi-key OAuth (access + refresh) or structured metadata.

### Per-Agent Secrets (US-B1 — Merged)

Track B US-B1 from `stories-auth-smoke-tour-210.md` is **live**:
- `agents.runtimeConfig.secrets: Record<string, string>` — per-agent key-value secrets
- UI: `apps/web/app/(dashboard)/agent/[urlKey]/agent-secrets-form.tsx`
- Runtime: `packages/mastra/src/execution-workspace.ts` — injected as env vars into code-execution sandbox
- **Write-only after save**: Secrets UI never redisplays plaintext values (AC-B1.1, AC-B1.2)

**Design note**: US-B1 `secrets` are **orthogonal** to plugin credentials. Secrets are for test credentials (`TEST_EMAIL`, `TEST_PASSWORD`) and user-defined env vars. Vault will store MCP/plugin credentials separately.

---

## Goal Statement for P0

Implement a **secure, scoped credential vault** that:
1. Stores MCP/plugin credentials with application-level encryption (ciphertext in DB).
2. Supports three scopes: `company` (all agents), `company_user` (one human user), `agent` (one agent).
3. Handles static API keys + OAuth (access token + refresh token).
4. Never exposes plaintext/ciphertext to models, logs, or UI after save (write-only inputs).
5. Implements `needs_reauth` state for expired/invalid tokens (UI reconnect flow).
6. Migrates existing `settings.mcpCredentials` → vault (one-shot or compatibility shim).
7. Passes Test quality gates (unit + integration) before product PR merge.

**Success criteria**: Dev ships vault schema + API + UI; Test ACCEPT gates pass; Buffer/GitHub MCP credentials migrate cleanly; no secrets leak to agent prompts/logs.

---

## User Stories

### US-V1: Vault Schema + Encrypted Storage

**As** a developer  
**I want** a `vault_secrets` table (or equivalent) with application-level encryption at rest  
**So that** MCP credentials are stored as ciphertext and never appear in plaintext DB dumps or logs

#### Acceptance Criteria

- [ ] **AC-V1.1**: Database schema includes credential storage table
  - Suggested name: `vault_secrets` (or `plugin_credentials`)
  - Columns (minimum): `id`, `companyId`, `scope`, `serverId`, `userId` (nullable), `agentId` (nullable), `encryptedValue`, `authType`, `needsReauth`, `createdAt`, `updatedAt`
  - `scope` enum: `company` | `company_user` | `agent`
  - `authType` enum: `api_key` | `oauth`
  - `encryptedValue`: JSONB or TEXT — stores encrypted payload (API key string or OAuth `{ accessToken, refreshToken, expiresAt }`)
  - Indexes: `companyId`, `(companyId, serverId, scope, userId, agentId)` unique constraint

- [ ] **AC-V1.2**: Encryption helper functions
  - `encryptCredential(plaintext: string | OAuthTokens): string` — returns ciphertext
  - `decryptCredential(ciphertext: string): string | OAuthTokens` — returns plaintext (never logged or returned to UI)
  - Key management: Use `process.env.VAULT_ENCRYPTION_KEY` (32-byte hex or base64); rotate support optional for P0

- [ ] **AC-V1.3**: No plaintext in logs or DB dumps
  - Plaintext credentials only exist in memory during encrypt/decrypt operations
  - No `console.log`, `logger.debug`, or observability span includes plaintext/ciphertext
  - Test: Grep logs for sample API key — must not appear

- [ ] **AC-V1.4**: Migration SQL generated and applied
  - Drizzle migration file created: `pnpm db:generate`
  - Migration applied to TEST without errors: `pnpm db:migrate`

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Schema exists** | `vault_secrets` table in TEST Postgres, columns match AC-V1.1 | Ops + Test Lead |
| **Encryption roundtrip** | Unit test: encrypt → decrypt returns original plaintext | Dev |
| **No leaks** | Grep logs/observability for sample key — empty result | Test Lead |

#### Out of Scope

- Key rotation automation (manual key change acceptable for P0)
- Multiple encryption keys (single key per environment)
- Hardware Security Module (HSM) integration

---

### US-V2: Scoped Credential Resolution API

**As** an agent runtime (WakeRunner)  
**I want** a `resolvePluginCredential(companyId, serverId, scope, userId?, agentId?)` API  
**So that** MCP clients receive the correct credential for the current scope without accessing DB directly

#### Acceptance Criteria

- [ ] **AC-V2.1**: Credential resolution helper function
  - Location: `packages/shared/src/vault-credentials.ts` (or equivalent)
  - Function signature:
    ```typescript
    resolvePluginCredential(ctx: {
      companyId: string;
      serverId: string; // MCP server ID, e.g. 'buffer-mcp'
      agentId?: string;
      userId?: string;
    }): Promise<string | OAuthTokens | null>
    ```
  - Resolution order (same as current `resolveMcpCredential`):
    1. Agent-scoped credential (if `agentId` provided + exists)
    2. User-scoped credential (if `userId` provided + exists)
    3. Company-scoped credential
    4. `process.env[MCP_SERVER_ENV_VAR]` fallback (backward compat)
    5. Return `null` if not found

- [ ] **AC-V2.2**: Scope semantics enforced
  - `company` scope: Any agent in the company can read (no `agentId` filter)
  - `company_user` scope: Only wakes for that `userId` can read (requires `userId` match)
  - `agent` scope: Only that specific `agentId` can read (requires `agentId` match)
  - Test: Agent A cannot read Agent B's scoped credential

- [ ] **AC-V2.3**: OAuth token refresh on expiry
  - If `authType === 'oauth'` and `expiresAt < now()`, attempt refresh via provider-specific OAuth helper
  - Update `vault_secrets` row with new `accessToken` + `expiresAt`
  - If refresh fails, set `needsReauth = true` and return `null`

- [ ] **AC-V2.4**: Integration with existing `resolveMcpCredential()`
  - Backward compat: `resolveMcpCredential()` checks vault first, then falls back to `settings.mcpCredentials`
  - Or: Deprecate old function, update all call sites to new `resolvePluginCredential()`

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Resolution order correct** | Unit test: agent → company → env fallback | Dev |
| **Scope isolation** | Integration test: Agent A cannot read Agent B's secret | Test Lead |
| **OAuth refresh** | Mock OAuth provider, verify token refresh + DB update | Dev |

#### Out of Scope

- User-scoped credentials for human users (no human auth system in P0)
- Multi-tenant credential sharing across companies

---

### US-V3: Static API Key Bind (Never Expose After Save)

**As** a company admin or agent operator  
**I want** to save a static API key (e.g. Buffer, GitHub) via UI  
**So that** the key is encrypted and never redisplayed in plaintext after save

#### Acceptance Criteria

- [ ] **AC-V3.1**: Company-scoped API key UI
  - Location: `/settings` page, **Integrations** tab (existing location)
  - Replace current `mcpCredentials['buffer-mcp']` input with vault-backed input
  - Input type: `password`; placeholder: `••••••••` if credential exists
  - On save: Call `POST /api/vault/credentials` with `{ scope: 'company', serverId: 'buffer-mcp', authType: 'api_key', value: <plaintext> }`
  - Response: 201 Created, no plaintext echoed back

- [ ] **AC-V3.2**: Agent-scoped API key UI
  - Location: `/agent/{urlKey}` page, **Capabilities** tab (existing integration overrides section)
  - Similar password input for Buffer, Tavily, SearXNG overrides
  - On save: `POST /api/vault/credentials` with `{ scope: 'agent', agentId, serverId, authType: 'api_key', value }`

- [ ] **AC-V3.3**: Write-only after save
  - Password input never pre-fills with plaintext (placeholder only)
  - "Clear stored key" checkbox (like existing `clearBufferApiKey`) to delete credential
  - No API endpoint returns plaintext; only `{ configured: true | false }` status

- [ ] **AC-V3.4**: Ciphertext never in API responses, logs, observability
  - API logs: Request body sanitized (replace `value` with `[REDACTED]`)
  - Observability spans: Credential values excluded from span attributes/payload
  - Test: Grep observability DB table for sample API key — must not appear

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Save + resolve** | Save Buffer API key via UI, agent resolves it on next wake | Test Lead |
| **Write-only enforced** | Refresh settings page after save, input shows `••••••••` | Test Lead |
| **No leaks** | Grep logs/observability for sample key — empty | Test Lead |

#### Out of Scope

- Credential versioning or audit log (who changed what when)
- Bulk import/export of credentials

---

### US-V4: OAuth Connect + Refresh + `needs_reauth`

**As** a company admin  
**I want** to connect an OAuth-based MCP server (e.g. GitHub, Google)  
**So that** Tourbillon stores access + refresh tokens, auto-refreshes on expiry, and prompts reconnect on failure

#### Acceptance Criteria

- [ ] **AC-V4.1**: OAuth connect flow (company-scoped)
  - UI: `/settings` Integrations tab, **Connect GitHub** button (or similar)
  - Click → redirect to `GET /api/vault/oauth/authorize?serverId=github-mcp&scope=company`
  - API redirects to GitHub OAuth URL with callback `{BETTER_AUTH_URL}/api/vault/oauth/callback?serverId=github-mcp&scope=company`
  - Callback receives `code`, exchanges for `accessToken` + `refreshToken`, encrypts, saves to `vault_secrets` with `authType=oauth`
  - Redirect back to `/settings?connected=github-mcp`

- [ ] **AC-V4.2**: OAuth token storage structure
  - `encryptedValue` JSONB (encrypted):
    ```json
    {
      "accessToken": "gho_...",
      "refreshToken": "ghr_...",
      "expiresAt": 1732800000000,  // Unix ms
      "scope": "repo,user"  // optional
    }
    ```

- [ ] **AC-V4.3**: Automatic refresh on expiry
  - When `resolvePluginCredential()` detects `expiresAt < Date.now()`, call provider-specific refresh endpoint
  - Update `vault_secrets` row with new `accessToken` + `expiresAt`
  - If refresh fails (e.g. `invalid_grant`), set `needsReauth = true`, return `null`

- [ ] **AC-V4.4**: `needs_reauth` state + UI reconnect
  - When `needsReauth = true`, UI badge: "⚠ GitHub: Reconnect required"
  - Click **Reconnect** → same OAuth flow as AC-V4.1, overwrites existing credential
  - On successful reconnect, set `needsReauth = false`

- [ ] **AC-V4.5**: Agent runtime behavior on `needs_reauth`
  - If `resolvePluginCredential()` returns `null` (due to `needsReauth`), agent tool call fails with user-facing error: "GitHub credential expired. Reconnect in Settings."
  - Error **not** written to model context (no plaintext credential hints in prompt)

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **OAuth connect** | Complete GitHub OAuth flow, token stored encrypted | Test Lead |
| **Token refresh** | Mock expired token, verify refresh API called + DB updated | Dev |
| **Reconnect flow** | Set `needsReauth=true`, verify UI badge + reconnect succeeds | Test Lead |
| **No token leaks** | Grep logs for `gho_`, `ghr_` — empty | Test Lead |

#### Out of Scope

- Agent-scoped OAuth (OAuth is company/user only for P0; agents inherit company token)
- Multi-account OAuth (one credential per server per scope)
- PKCE support (standard OAuth code flow sufficient for P0)

---

### US-V5: Migrate `settings.mcpCredentials` → Vault

**As** a developer  
**I want** existing Buffer/GitHub credentials migrated from `settings.mcpCredentials` to vault  
**So that** companies on TEST don't lose their working integrations after vault ships

#### Acceptance Criteria

- [ ] **AC-V5.1**: Migration strategy chosen
  - **Option A (one-shot)**: Migration script reads `companies.settings.mcpCredentials`, encrypts, writes to `vault_secrets`, clears old field
  - **Option B (compatibility shim)**: `resolvePluginCredential()` checks vault first, falls back to `settings.mcpCredentials` (no migration script)
  - Decision: Document chosen option in this AC (Dev + PM agreement)

- [ ] **AC-V5.2**: No data loss
  - Before migration: Export TEST `settings.mcpCredentials` to JSON backup
  - After migration: Verify all `mcpCredentials` entries exist in `vault_secrets` (company scope)
  - Test: Buffer MCP tool still works post-migration

- [ ] **AC-V5.3**: Migration script (if Option A)
  - Path: `packages/db/scripts/migrate-mcp-to-vault.ts`
  - Idempotent: Safe to run multiple times (skip if vault entry already exists)
  - Runnable: `pnpm db:migrate-mcp` or similar

- [ ] **AC-V5.4**: Backward compatibility removed (if Option A)
  - Remove `settings.mcpCredentials` JSONB field from schema (or mark deprecated)
  - Update `resolveMcpCredential()` to only check vault (no fallback to old field)
  - Or: Keep field for 1 release as read-only fallback, delete in P1

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Migration dry-run** | Run on TEST, verify no errors, all credentials present | Ops |
| **No regressions** | Buffer tool call succeeds on TEST after migration | Test Lead |
| **Backup verified** | JSON backup contains pre-migration credentials | Ops |

#### Out of Scope

- Migrating per-agent `runtimeConfig.mcpCredentials` (rare; handle manually or in P1)
- Rollback script (backup + re-run setup sufficient for TEST)

---

### US-V6: UI Connect/Reconnect (Write-Only Inputs)

**As** a company admin  
**I want** the Settings UI to clearly show which integrations are connected without exposing secrets  
**So that** I can manage credentials safely

#### Acceptance Criteria

- [ ] **AC-V6.1**: Integration status badges
  - Location: `/settings` Integrations tab
  - Each MCP server (Buffer, GitHub, Tavily, SearXNG): Badge showing "✓ Connected" or "Not configured"
  - If `needsReauth = true`: Badge shows "⚠ Reconnect required"

- [ ] **AC-V6.2**: Write-only credential inputs
  - API key fields: `type="password"`, placeholder `••••••••` if configured
  - No plaintext returned by `GET /api/vault/credentials` (only `{ serverId, configured: boolean, needsReauth: boolean }`)
  - OAuth: **Connect** / **Reconnect** buttons (no input field)

- [ ] **AC-V6.3**: Delete credential action
  - Checkbox: "Clear stored credential" (like existing `clearBufferApiKey`)
  - On save: `DELETE /api/vault/credentials` with `{ serverId, scope, agentId? }`

- [ ] **AC-V6.4**: Agent capabilities UI update
  - Location: `/agent/{urlKey}` Capabilities tab
  - Per-agent integration overrides show same write-only inputs
  - Badge: "Inherited from company" vs. "Agent override"

#### Quality Gates (Test ACCEPT/HOLD)

| Gate | Condition | Verifier |
|------|-----------|----------|
| **Status accurate** | Save credential, badge shows "✓ Connected" | Test Lead |
| **Write-only enforced** | Refresh page, input never shows plaintext | Test Lead |
| **Delete works** | Check "Clear", save, credential removed | Test Lead |

#### Out of Scope

- Credential usage logs (when last used by which agent)
- Share credential between companies (each company isolated)

---

### US-V7: Test Quality Gates

**As** Test Lead  
**I want** explicit Test ACCEPT/HOLD gates before product PR merge  
**So that** vault ships with confidence and no security regressions

#### Acceptance Criteria

- [ ] **AC-V7.1**: Unit tests (Dev responsibility)
  - `encryptCredential` / `decryptCredential` roundtrip (10+ test cases)
  - `resolvePluginCredential` resolution order (agent → company → env → null)
  - OAuth token refresh (mock provider API)
  - Scope isolation (Agent A cannot read Agent B's credential)

- [ ] **AC-V7.2**: Integration tests (Dev + Test)
  - End-to-end: Save Buffer API key via UI → agent calls Buffer MCP tool → succeeds
  - OAuth flow: Mock GitHub OAuth → save token → verify encrypted in DB
  - Migration: Run migration script on TEST → verify Buffer tool still works

- [ ] **AC-V7.3**: Security tests (Test Lead)
  - Grep logs for sample API key strings (plaintext + ciphertext) → empty results
  - Check observability DB `agent_observability_events` for credential values → empty
  - Check issue comments for credential leaks → empty (agent should never paste secrets)

- [ ] **AC-V7.4**: Ops verification
  - `vault_secrets` table exists on TEST
  - Migration script ran without errors (if Option A in US-V5)
  - No production outages or credential loss

#### Quality Gates Summary (Test ACCEPT/HOLD)

| Story | Gate | ACCEPT Condition | HOLD Condition |
|-------|------|------------------|----------------|
| **US-V1** | Schema exists | `vault_secrets` in TEST, migration applied | Table missing or columns wrong |
| **US-V2** | Resolution works | Agent resolves company/agent credential correctly | Wrong scope or null when should exist |
| **US-V3** | Write-only enforced | Input shows `••••••••`, no plaintext in API | Plaintext visible after save |
| **US-V4** | OAuth flow | Connect + refresh + reconnect succeed | Token leak in logs/observability |
| **US-V5** | Migration clean | Buffer tool works post-migration | Data loss or tool breaks |
| **US-V6** | UI polish | Status badges accurate, delete works | Badge incorrect or delete fails |
| **US-V7** | Tests pass | All unit/integration/security tests green | Any Test HOLD gate fires |

#### Out of Scope for V7

- Load testing (vault should handle TEST scale; production scale in P1)
- Penetration testing (assumes Postgres TLS + env var secrets follow best practices)

---

## Ops Sequence (Post-Dev-Ship)

Derek's workflow after Dev merges product PR:

- [ ] **Step 1**: Verify vault schema deployed to TEST
  - `psql` → check `vault_secrets` table exists
- [ ] **Step 2**: Set `VAULT_ENCRYPTION_KEY` in TEST `.env`
  - Generate: `openssl rand -hex 32`
  - Never commit to git; store in secure Ops storage
- [ ] **Step 3**: Run migration (if US-V5 Option A)
  - `pnpm db:migrate-mcp` or equivalent
  - Verify: `SELECT * FROM vault_secrets` contains Buffer/GitHub entries
- [ ] **Step 4**: Test Buffer integration
  - Settings → Buffer API key input → save
  - Assign Buffer tool to test agent → wake agent → verify tool call succeeds
- [ ] **Step 5**: Test OAuth (GitHub)
  - Settings → Connect GitHub → complete OAuth flow
  - Verify `vault_secrets` row with `authType=oauth`
- [ ] **Step 6**: Security audit
  - Grep TEST logs for sample API key → empty
  - Check observability DB → no credential values
- [ ] **Step 7**: Sign off on ACCEPT gates
  - All US-V1 through US-V7 gates pass → notify PM
  - If any HOLD gate fires → block merge, Dev fixes

**Ops note**: Do **not** pull this docs PR to TEST. Wait for Dev product PR + Test ACCEPT + Derek merge yes + Derek pull yes.

---

## Out of Scope (All Tracks)

Explicitly **not** in scope for P0:

1. **Human user authentication / org chart**
   - No login system for human admins; company-scoped credentials only
2. **Plugin catalog UI**
   - No `/plugins` page or search/browse; hardcoded MCP servers only
3. **Plugin install/uninstall flow**
   - MCP servers are manually configured via `settings.mcpCredentials` → vault migration
4. **Email / channels / self-inspect tools**
   - P2 features; mention only as future work
5. **Multi-key API auth (e.g. key + secret pair)**
   - Store as JSON in `encryptedValue` if needed; no schema changes
6. **Key rotation automation**
   - Manual key change acceptable; rotate `VAULT_ENCRYPTION_KEY` + re-encrypt in P1
7. **Credential audit logs**
   - Who changed/accessed what when — future work
8. **Cross-company credential sharing**
   - Each company isolated; no shared vault

---

## Soft Leftovers (Non-Blocking)

Known gaps to revisit in P1:

1. **`projects/auth-smoke-tests.sh` check 2 is still cookie-only**
   - Bearer session token not in smoke script (from `stories-auth-smoke-tour-210.md`)
   - Separate from P0 vault work unless product asks
2. **Per-agent `runtimeConfig.mcpCredentials` migration**
   - Rare case; migrate manually or batch in P1
3. **OAuth PKCE support**
   - Standard flow sufficient for P0; add PKCE for mobile/native apps in P1

---

## Related Resources

- **AGENTS.md**: Tourbillon agent architecture, tool tiers, MCP integration
- **docs/stories-auth-smoke-tour-210.md**: Auth smoke testing stories (Track B US-B1 per-agent secrets)
- **packages/shared/src/mcp-credentials.ts**: Current MCP credential resolution
- **apps/web/app/(dashboard)/settings/page.tsx**: Company settings UI (Integrations tab)
- **apps/web/app/(dashboard)/agent/[urlKey]/page.tsx**: Agent detail page (Capabilities tab)

---

## Document Maintenance

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-09-26 | Docs PR (plugin-vault-p0) | Initial draft with US-V1 through US-V7 stories |

---

**End of Document**
