# Auth Smoke Test Setup Guide

This document describes the operational steps required to set up and run authentication smoke tests on the TEST environment, implementing user stories US-A1 through US-A5 from TOUR-210.

## Prerequisites

- PostgreSQL database is running and accessible
- Tourbillon web app is deployed on TEST
- Database migrations have been applied (includes user/session tables)

---

## Step 1: Apply Database Migrations (US-A2)

The auth smoke test implementation includes migration `0013_flimsy_wonder_man.sql` which creates the following tables:

- `user` — User accounts with email/password
- `account` — Credential storage (password hashes)
- `session` — Active user sessions
- `verification` — Email verification tokens (unused in smoke tests)

**Apply migrations:**

```bash
cd /workspace
set -a && source .env && set +a
pnpm db:migrate
```

**Verify schema:**

```bash
psql $DATABASE_URL -c "\dt user"
psql $DATABASE_URL -c "\dt session"
psql $DATABASE_URL -c "\dt account"
```

Expected: All three tables exist.

---

## Step 2: Create Throwaway Test User (US-A3)

Use the idempotent seed script to create a test user account:

```bash
cd /workspace
TEST_EMAIL=testsuper@example.com \
TEST_PASSWORD=$(openssl rand -base64 24) \
tsx scripts/seed-test-user.ts
```

**Important:**
- Use a **fake, non-deliverable email domain** (e.g., `@example.com`, `@test.local`)
- Generate a **random password** — never use a production password
- Store the generated password securely (see Step 3)
- This script is **idempotent** — running it again updates the password

**Manual alternative (SQL):**

If `tsx` is unavailable, you can create the user manually:

```sql
-- Replace PASSWORD_HASH with output of: echo -n "your_password" | sha256sum
INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
VALUES (
  concat(extract(epoch from now())::text, '_', substr(md5(random()::text), 1, 9)),
  'Test Super',
  'testsuper@example.com',
  true,
  now(),
  now()
) ON CONFLICT (email) DO UPDATE SET "updatedAt" = now()
RETURNING id;

-- Note the returned user ID, then insert the account:
INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
VALUES (
  concat(extract(epoch from now())::text, '_', substr(md5(random()::text), 1, 9)),
  '<USER_ID_FROM_ABOVE>',
  'credential',
  '<USER_ID_FROM_ABOVE>',
  '<PASSWORD_HASH>',
  now(),
  now()
);
```

---

## Step 3: Store Test Credentials (US-A4)

Create a **mode-600** host file for the smoke test script to source:

```bash
# On the TEST host (e.g., tourbillon-test machine)
mkdir -p ~/tourbillon
cat > ~/tourbillon/.env.test-auth <<EOF
TEST_EMAIL=testsuper@example.com
TEST_PASSWORD=<PASSWORD_FROM_STEP_2>
TEST_API_BASE=http://127.0.0.1:3002
EOF

chmod 600 ~/tourbillon/.env.test-auth
```

**Security requirements:**
- File **MUST** have mode 600 (owner read/write only)
- Credentials **NEVER** committed to git
- Credentials **NEVER** in agent SOUL, instructions, or issue comments
- Credentials **NEVER** in chat or board approval text

**Verify:**

```bash
ls -l ~/tourbillon/.env.test-auth
# Expected: -rw------- (mode 600)
```

---

## Step 4: Verify Auth Endpoints (US-A1)

Ensure the auth endpoints are deployed and reachable:

```bash
# Check login endpoint exists (not 404)
curl -X POST http://127.0.0.1:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"wrong"}' -i

# Expected: HTTP 401 (not 404 or 500)

# Check session endpoint exists
curl -X GET http://127.0.0.1:3002/api/auth/session -i

# Expected: HTTP 401 with {"authenticated":false} (not 404)
```

---

## Step 5: Run Smoke Tests (US-A5)

Execute the smoke test script:

```bash
cd /workspace
./projects/auth-smoke-tests.sh
```

**Expected output:**

```
==========================================
Tourbillon Auth Smoke Tests
==========================================
API Base: http://127.0.0.1:3002
Test User: testsuper@example.com

Check 1: Login with valid credentials ... PASS
Check 2: Session endpoint authenticated ... PASS
Check 3: Login with wrong password fails ... PASS

==========================================
All checks passed.
```

**Exit codes:**
- `0` — All checks passed
- `1` — At least one check failed or missing credentials

**What the script checks:**
1. `POST /api/auth/login` with valid credentials returns 200 + success
2. `GET /api/auth/session` with session cookie returns 200 + authenticated
3. `POST /api/auth/login` with wrong password returns 401
4. No credentials are echoed in output

---

## API Contracts

### POST /api/auth/login

**Request:**
```json
{
  "email": "string",
  "password": "string"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "sessionId": "string",
  "userId": "string"
}
```

**Error Response (401/400):**
```json
{
  "success": false,
  "error": "string"
}
```

**Status codes:**
- `200` — Login successful, session created
- `401` — Invalid email or password
- `400` — Malformed request (missing fields, invalid email format)
- `500` — Internal server error

**Session management:**
- Session cookie is set via `Set-Cookie` header
- Cookie name: `better-auth.session_token` (or similar)
- Cookie is httpOnly, secure in production

---

### GET /api/auth/session

**Request:**
- Requires session cookie from login response
- Or `Authorization: Bearer <token>` header

**Success Response (200):**
```json
{
  "authenticated": true,
  "user": {
    "id": "string",
    "email": "string",
    "name": "string"
  }
}
```

**No Session Response (401):**
```json
{
  "authenticated": false,
  "error": "No active session"
}
```

**Status codes:**
- `200` — Valid session, user authenticated
- `401` — No session or invalid session

---

## Troubleshooting

### Smoke test fails with "TEST_EMAIL is required"

**Cause:** Missing credentials file or env vars not set

**Fix:**
```bash
# Verify file exists and is readable
ls -l ~/tourbillon/.env.test-auth
cat ~/tourbillon/.env.test-auth  # Should show TEST_EMAIL and TEST_PASSWORD

# Or export env vars directly
export TEST_EMAIL=testsuper@example.com
export TEST_PASSWORD=<your_password>
./projects/auth-smoke-tests.sh
```

---

### Endpoints return 404

**Cause:** Auth routes not deployed or Next.js build is stale

**Fix:**
```bash
cd /workspace
pnpm build  # Rebuild Next.js app
# Restart the web process
```

---

### Login succeeds but session check fails

**Cause:** Session cookie not being set or read correctly

**Debug:**
```bash
# Check cookie in login response
curl -v -X POST http://127.0.0.1:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"testsuper@example.com","password":"<PASSWORD>"}' 2>&1 | grep -i cookie

# Manually test session with cookie
curl -X GET http://127.0.0.1:3002/api/auth/session \
  --cookie "better-auth.session_token=<TOKEN_FROM_ABOVE>"
```

---

### Database connection errors

**Cause:** `DATABASE_URL` not set or postgres not reachable

**Fix:**
```bash
# Check connection
psql $DATABASE_URL -c "SELECT 1"

# Verify .env is sourced
echo $DATABASE_URL
```

---

## Security Checklist

Before enabling TestSuper or unattended smoke tests:

- [ ] Test user email uses a fake domain (`@example.com`, `@test.local`)
- [ ] `~/tourbillon/.env.test-auth` has mode 600
- [ ] Password is random, not reused from any real account
- [ ] No credentials in git history: `git log --all -p | grep -i 'TEST_PASSWORD\|testsuper@example.com'` returns empty
- [ ] No credentials in agent SOUL or instructions
- [ ] No credentials in issue bodies or comments
- [ ] Migrations applied and tables exist in TEST postgres
- [ ] Smoke test script exits 0 (all checks pass)

---

## Next Steps (Out of Scope for US-A1–A5)

- **US-A6:** TestSuper hire gate — wait for PM/Test approval before enabling heartbeats
- **US-B1:** Per-agent secrets/variables (Track B, P1)
- **Production hardening:** Rate limiting, session expiration, HTTPS-only cookies
- **CI/CD integration:** Automated smoke test runs on deploy

---

## Related Documentation

- `docs/stories-auth-smoke-tour-210.md` — User story definitions (TOUR-210)
- `AGENTS.md` — Agent tool tiers and capabilities
- `DEVELOP.md` — Developer setup guide
- `packages/db/src/migrations/0013_flimsy_wonder_man.sql` — Auth schema migration
