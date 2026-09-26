# Database Scripts

## migrate-mcp-to-vault.ts

**US-V5 Option A**: One-shot migration of `settings.mcpCredentials` → vault with verification.

### Usage

```bash
# 1. Dry-run to preview changes
pnpm db:migrate-mcp --dry-run

# 2. Run migration (creates backup automatically)
pnpm db:migrate-mcp

# 3. Verify vault credentials work
# - Check settings UI shows "✓ Configured"
# - Test Buffer tool call succeeds

# 4. Clear legacy field after verification
pnpm db:migrate-mcp --clear-legacy
```

### Options

- `--dry-run` — Preview changes without modifying database
- `--skip-backup` — Skip automatic backup creation (not recommended)
- `--clear-legacy` — Remove `settings.mcpCredentials` field after verification

### Safety

- **Idempotent**: Safe to run multiple times (skips existing vault entries)
- **Automatic backup**: Saves to `backups/mcp-credentials-backup-*.json` (unless `--skip-backup`)
- **Two-phase**: Migrate first, verify, then clear legacy field

### PM Decision

Per PM:Tourbillon decision #2, this is **Option A** (one-shot) not Option B (long-term dual-read).

Dual-read fallback is temporary during transition window only. After `--clear-legacy`, resolution uses vault + env only.

### Environment

Requires: `VAULT_ENCRYPTION_KEY` (32 bytes / 64 hex chars)

```bash
# Generate key
openssl rand -hex 32
```
