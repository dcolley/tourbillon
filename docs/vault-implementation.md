# Plugin Vault Implementation — P0

This document describes the implementation of Tourbillon's Plugin Vault feature for secure, scoped credential storage.

## Overview

The Plugin Vault provides:

- **Scoped credentials**: Company-wide, user-specific, or agent-specific storage
- **Application-level encryption**: AES-256-GCM encryption with per-environment keys
- **OAuth support**: Token storage with automatic refresh and `needs_reauth` state
- **Write-only UI**: Credentials never redisplayed after save
- **Backward compatibility**: Dual-read fallback to legacy `settings.mcpCredentials`

## Architecture

### Database Schema

The `vault_secrets` table stores encrypted credentials:

```sql
CREATE TABLE vault_secrets (
  id text PRIMARY KEY,
  company_id text NOT NULL REFERENCES companies(id),
  server_id text NOT NULL,
  scope text NOT NULL, -- 'company' | 'company_user' | 'agent'
  user_id text REFERENCES user(id),
  agent_id text REFERENCES agents(id),
  auth_type text NOT NULL, -- 'api_key' | 'oauth'
  encrypted_value text NOT NULL,
  needs_reauth boolean DEFAULT false,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now(),
  UNIQUE(company_id, server_id, scope, user_id, agent_id)
);
```

### Encryption

**Algorithm**: AES-256-GCM with random IV per encryption operation

**Key Management**: Set `VAULT_ENCRYPTION_KEY` environment variable (32 bytes / 64 hex chars)

```bash
# Generate a new key
openssl rand -hex 32

# Add to .env
VAULT_ENCRYPTION_KEY=<64-char-hex-string>
```

**Implementation**: `packages/shared/src/vault-encryption.ts`

- `encryptCredential(plaintext: string | OAuthTokens): string` — Returns base64-encoded ciphertext
- `decryptCredential(ciphertext: string): string | OAuthTokens` — Returns plaintext (never logged)
- `sanitizeForLogging(obj: any): any` — Redacts sensitive keys for logging

### Resolution API

**Function**: `resolvePluginCredential(ctx: VaultCredentialContext): Promise<string | OAuthTokens | null>`

**Resolution order** (AC-V2.1):

1. Agent-scoped credential (if `agentId` provided)
2. User-scoped credential (if `userId` provided)
3. Company-scoped credential
4. Legacy `settings.mcpCredentials` (backward compat)
5. Environment variable fallback (e.g. `BUFFER_API_KEY`)
6. Return `null` if not found

**OAuth token refresh** (AC-V2.3):

- Checks `expiresAt < Date.now()` before returning
- Calls provider-specific refresh endpoint (GitHub implemented)
- Updates `vault_secrets` row with new tokens
- Sets `needsReauth = true` if refresh fails

**Implementation**: `packages/shared/src/vault-credentials.ts`

## API Routes

### POST /api/vault/credentials

Save or update a credential.

**Request body**:

```json
{
  "serverId": "buffer-mcp",
  "scope": "company",
  "authType": "api_key",
  "value": "sk-test-123",
  "userId": "user_abc", // optional, for company_user scope
  "agentId": "agent_xyz" // optional, for agent scope
}
```

**Response**: `201 Created` or `200 OK`, no plaintext echoed

### GET /api/vault/credentials

Get credential status (never returns plaintext).

**Query params**: `serverId`, `scope`, `userId?`, `agentId?`

**Response**:

```json
{
  "serverId": "buffer-mcp",
  "configured": true,
  "needsReauth": false,
  "authType": "api_key"
}
```

### DELETE /api/vault/credentials

Delete a credential.

**Request body**:

```json
{
  "serverId": "buffer-mcp",
  "scope": "company",
  "userId": "user_abc", // optional
  "agentId": "agent_xyz" // optional
}
```

### GET /api/vault/oauth/authorize

Initiate OAuth flow (currently supports GitHub only).

**Query params**: `serverId=github-mcp`, `scope=company`, `userId?`, `agentId?`

**Behavior**: Redirects to provider OAuth page with state

### GET /api/vault/oauth/callback

OAuth callback handler. Exchanges code for tokens, encrypts, saves to vault.

**Behavior**: Redirects to `/settings?connected=<serverId>` on success

## OAuth Configuration

**GitHub OAuth** (AC-V4.1):

1. Register OAuth app at https://github.com/settings/developers
2. Set callback URL: `{BETTER_AUTH_URL}/api/vault/oauth/callback`
3. Add to `.env`:

```bash
GITHUB_OAUTH_CLIENT_ID=Iv1.abc123
GITHUB_OAUTH_CLIENT_SECRET=abc123def456
```

**Supported scopes**: `repo,user` (required for GitHub MCP tools)

## Migration

**Script**: `packages/db/scripts/migrate-mcp-to-vault.ts`

**Usage**:

```bash
# Set encryption key first
export VAULT_ENCRYPTION_KEY=$(openssl rand -hex 32)

# Run migration (idempotent — safe to run multiple times)
pnpm db:migrate-mcp
```

**Behavior**:

- Reads all companies' `settings.mcpCredentials`
- For each server ID, creates a `company`-scoped vault entry
- Skips if vault entry already exists (idempotent)
- Does **not** delete legacy field (dual-read compat)

**Dual-read fallback** (US-V5 Option B):

The resolution API checks vault first, then falls back to `settings.mcpCredentials` and env vars. This ensures no credentials are lost during migration and allows a gradual rollout.

## UI Components

### VaultCredentialInput (client component)

Reusable credential input with write-only behavior.

**Props**:

- `serverId`: MCP server ID (e.g. `buffer-mcp`)
- `scope`: `company` | `company_user` | `agent`
- `configured`: Whether credential exists
- `needsReauth`: OAuth reconnect required
- `authType`: `api_key` | `oauth`
- `label`: Display label
- `envFallback`: Environment variable fallback value

**Features**:

- Password input (never pre-fills plaintext)
- Status badge: "✓ Configured" / "Not configured" / "⚠ Reconnect required"
- "Clear stored key" checkbox for deletion
- OAuth: "Connect" / "Reconnect" button (no input field)

**Usage** (settings page):

```tsx
<VaultCredentialInput
  serverId="buffer-mcp"
  scope="company"
  configured={vaultStatus.configured}
  needsReauth={vaultStatus.needsReauth}
  authType={vaultStatus.authType}
  label="Buffer API key"
  description="Enables the Buffer toolset."
  envFallback={process.env.BUFFER_API_KEY}
/>
```

## Testing

### Unit Tests

Run encryption tests:

```bash
pnpm --filter @tourbillon/shared test
```

**Test coverage** (AC-V7.1):

- `encryptCredential` / `decryptCredential` roundtrip (10+ cases)
- Random IV uniqueness
- Special characters and unicode
- OAuth token structure
- `sanitizeForLogging` redaction (nested objects, arrays)

### Integration Testing

**Manual test flow** (AC-V7.2):

1. Start infrastructure: `docker compose up -d postgres redis`
2. Apply migration: `pnpm db:migrate`
3. Set vault key: `export VAULT_ENCRYPTION_KEY=$(openssl rand -hex 32)`
4. Start web: `pnpm dev`
5. Navigate to `/settings` → Integrations
6. Enter Buffer API key, save
7. Assign Buffer toolset to test agent
8. Wake agent, verify tool call succeeds

**Security audit** (AC-V7.3):

```bash
# Grep logs for sample key (must be empty)
grep -r "sk-test-1234567890abcdef" logs/

# Check observability DB for leaks
psql $DATABASE_URL -c "SELECT payload FROM agent_observability_events WHERE payload LIKE '%sk-test%';"
```

## Security Notes (AC-V1.3)

**Do:**

- ✅ Use `sanitizeForLogging()` before any `console.log` or logger call
- ✅ Encrypt immediately after user input
- ✅ Decrypt only when needed (e.g. calling external API)
- ✅ Store plaintext in memory for minimum duration

**Don't:**

- ❌ Log plaintext or ciphertext values
- ❌ Return plaintext in API responses (use status objects)
- ❌ Include credentials in observability span payloads
- ❌ Write credentials to issue comments or agent prompts

**Observability exclusion**:

The `sanitizeForLogging` function redacts sensitive keys automatically. Observability spans must not include tool call arguments containing credentials.

## Acceptance Criteria Status

| AC | Description | Status |
|----|-------------|--------|
| AC-V1.1 | Database schema with scopes and encryption | ✅ Complete |
| AC-V1.2 | Encryption/decryption helpers | ✅ Complete |
| AC-V1.3 | No plaintext in logs/DB dumps | ✅ Complete |
| AC-V1.4 | Migration SQL generated | ✅ Complete |
| AC-V2.1 | Credential resolution API | ✅ Complete |
| AC-V2.2 | Scope semantics enforced | ✅ Complete |
| AC-V2.3 | OAuth token refresh on expiry | ✅ Complete |
| AC-V3.1 | Company-scoped API key UI | ✅ Complete |
| AC-V3.2 | Agent-scoped API key UI | ⚠️ Partial (component ready, not wired to agent page) |
| AC-V3.3 | Write-only after save | ✅ Complete |
| AC-V3.4 | Ciphertext never in responses/logs | ✅ Complete |
| AC-V4.1 | OAuth connect flow | ✅ Complete (GitHub) |
| AC-V4.2 | OAuth token storage | ✅ Complete |
| AC-V4.3 | Automatic refresh | ✅ Complete |
| AC-V4.4 | `needs_reauth` state + reconnect | ✅ Complete |
| AC-V5.1 | Migration strategy | ✅ Complete (dual-read Option B) |
| AC-V5.2 | No data loss | ✅ Complete (idempotent script) |
| AC-V5.3 | Migration script | ✅ Complete |
| AC-V6.1 | Integration status badges | ✅ Complete |
| AC-V6.2 | Write-only credential inputs | ✅ Complete |
| AC-V6.3 | Delete credential action | ✅ Complete |
| AC-V7.1 | Unit tests | ✅ Complete (encryption) |

## Remaining Work (P1)

**Out of scope for P0 (per spec)**:

- Agent-scoped UI (AC-V3.2) — component exists, needs wiring to agent detail page
- User-scoped credentials — no human auth system in P0
- Additional OAuth providers (Google, etc.)
- Key rotation automation
- Credential audit logs
- Plugin catalog UI (P1 feature)

## Environment Variables Summary

| Variable | Required | Purpose |
|----------|----------|---------|
| `VAULT_ENCRYPTION_KEY` | ✅ Yes | 32-byte AES-256-GCM key (64 hex chars) |
| `GITHUB_OAUTH_CLIENT_ID` | For GitHub OAuth | OAuth app client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | For GitHub OAuth | OAuth app client secret |
| `BUFFER_API_KEY` | No | Fallback for Buffer (legacy env) |

## References

- **Spec**: `docs/stories-plugin-vault-p0.md`
- **Goal issue**: [#52](https://github.com/dcolley/tourbillon/issues/52)
- **User stories**: [#53](https://github.com/dcolley/tourbillon/issues/53)–[#59](https://github.com/dcolley/tourbillon/issues/59)
- **AGENTS.md**: Tool Tiers (Tier 3 MCP tools)

---

**Status**: Draft PR ready for Test acceptance gates
