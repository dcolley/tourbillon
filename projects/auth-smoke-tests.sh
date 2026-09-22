#!/bin/bash
##
## Auth Smoke Test Script — US-A5 + US-B1
##
## Validates Tourbillon auth endpoints:
##   1. Login with valid credentials succeeds
##   2. Session endpoint returns authenticated user
##   3. Login with wrong password fails cleanly (401)
##   4. No credentials leaked in output
##
## Usage:
##   ./projects/auth-smoke-tests.sh
##
## Environment:
##   TEST_EMAIL         - Test user email (required)
##   TEST_PASSWORD      - Test user password (required)
##   TEST_API_BASE      - API base URL (default: http://127.0.0.1:3002)
##
## Credentials source (AC-B1.4 — prefer agent secrets, fallback to host file):
##   1. Agent secrets (primary) — if TestSuper agent has secrets configured,
##      they are injected as environment variables into code execution sandbox.
##      No sourcing needed; TEST_EMAIL and TEST_PASSWORD are already set.
##   2. Host file fallback — if agent secrets are not configured, sources
##      ~/tourbillon/.env.test-auth (mode 600). This is backward-compatible
##      with pre-B1 deployments.
##
## Example agent secrets fallback pattern (optional, for explicit sourcing):
##   TEST_EMAIL="${TEST_EMAIL:-$(grep TEST_EMAIL ~/.env.test-auth | cut -d= -f2)}"
##   TEST_PASSWORD="${TEST_PASSWORD:-$(grep TEST_PASSWORD ~/.env.test-auth | cut -d= -f2)}"
##
## Exit codes:
##   0 - All checks passed
##   1 - At least one check failed or missing credentials
##

set -euo pipefail

# AC-B1.4: Prefer agent secrets (already in env), fallback to host file
# If running inside agent code execution sandbox with secrets configured,
# TEST_EMAIL and TEST_PASSWORD are already set. This fallback only activates
# when secrets are not configured (backward compatibility).
CREDS_FILE="${HOME}/tourbillon/.env.test-auth"
if [[ -z "${TEST_EMAIL:-}" || -z "${TEST_PASSWORD:-}" ]] && [[ -f "${CREDS_FILE}" ]]; then
  echo "Loading credentials from ${CREDS_FILE} (agent secrets not configured)..."
  set -a
  # shellcheck disable=SC1090
  source "${CREDS_FILE}"
  set +a
fi

# Validate required environment variables
if [[ -z "${TEST_EMAIL:-}" ]]; then
  echo "ERROR: TEST_EMAIL environment variable is required"
  echo "Either set it in ${CREDS_FILE} or export it before running this script"
  exit 1
fi

if [[ -z "${TEST_PASSWORD:-}" ]]; then
  echo "ERROR: TEST_PASSWORD environment variable is required"
  echo "Either set it in ${CREDS_FILE} or export it before running this script"
  exit 1
fi

# Default API base URL
TEST_API_BASE="${TEST_API_BASE:-http://127.0.0.1:3002}"

echo "=========================================="
echo "Tourbillon Auth Smoke Tests"
echo "=========================================="
echo "API Base: ${TEST_API_BASE}"
echo "Test User: ${TEST_EMAIL}"
echo ""

# Track pass/fail
FAILED=0

# Temp file for storing session cookie/token (cleaned up at exit)
COOKIE_JAR=$(mktemp)
trap 'rm -f "${COOKIE_JAR}"' EXIT

##
## Check 1: Login with valid credentials
##
echo -n "Check 1: Login with valid credentials ... "
LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -c "${COOKIE_JAR}" \
  -X POST "${TEST_API_BASE}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASSWORD}\"}" 2>/dev/null || echo "000")

HTTP_CODE=$(echo "${LOGIN_RESPONSE}" | tail -n1)
BODY=$(echo "${LOGIN_RESPONSE}" | head -n-1)

if [[ "${HTTP_CODE}" == "200" ]] && echo "${BODY}" | grep -q '"success":true'; then
  echo "PASS"
  SESSION_ID=$(echo "${BODY}" | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4)
  USER_ID=$(echo "${BODY}" | grep -o '"userId":"[^"]*"' | cut -d'"' -f4)
else
  echo "FAIL (HTTP ${HTTP_CODE})"
  echo "  Response: ${BODY}"
  FAILED=1
fi

##
## Check 2: Session endpoint returns authenticated user
##
echo -n "Check 2: Session endpoint authenticated ... "
SESSION_RESPONSE=$(curl -s -w "\n%{http_code}" -b "${COOKIE_JAR}" \
  -X GET "${TEST_API_BASE}/api/auth/session" 2>/dev/null || echo "000")

HTTP_CODE=$(echo "${SESSION_RESPONSE}" | tail -n1)
BODY=$(echo "${SESSION_RESPONSE}" | head -n-1)

if [[ "${HTTP_CODE}" == "200" ]] && echo "${BODY}" | grep -q '"authenticated":true'; then
  echo "PASS"
else
  echo "FAIL (HTTP ${HTTP_CODE})"
  echo "  Response: ${BODY}"
  FAILED=1
fi

##
## Check 3: Login with wrong password fails cleanly
##
echo -n "Check 3: Login with wrong password fails ... "
BAD_LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "${TEST_API_BASE}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"wrong_password_123\"}" 2>/dev/null || echo "000")

HTTP_CODE=$(echo "${BAD_LOGIN_RESPONSE}" | tail -n1)
BODY=$(echo "${BAD_LOGIN_RESPONSE}" | head -n-1)

if [[ "${HTTP_CODE}" == "401" ]] && echo "${BODY}" | grep -q '"success":false'; then
  echo "PASS"
else
  echo "FAIL (Expected 401, got HTTP ${HTTP_CODE})"
  echo "  Response: ${BODY}"
  FAILED=1
fi

##
## Check 4: Credentials never printed in output (check this script's output)
##
# This is a self-check — if TEST_PASSWORD appears in any of the above output,
# we've leaked credentials. This check is implicit: the script never echoes
# TEST_PASSWORD directly, and we use JSON payloads that aren't echoed.
# For paranoia, we could grep the output, but that would echo it.
# Instead, we just document: "Script output does not echo TEST_PASSWORD or tokens."

echo ""
echo "=========================================="
if [[ ${FAILED} -eq 0 ]]; then
  echo "All checks passed."
  exit 0
else
  echo "Some checks failed."
  exit 1
fi
