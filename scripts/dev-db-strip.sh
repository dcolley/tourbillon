#!/usr/bin/env bash
set -euo pipefail

# Strip Mac dev Postgres to minimal state: one company (smallest workload), one default
# LLM provider, no agents/issues/history. Flushes Redis and removes workspace dirs for
# deleted companies.
#
# Usage:
#   ./scripts/dev-db-strip.sh --dry-run
#   ./scripts/dev-db-strip.sh
#   ./scripts/dev-db-strip.sh --wipe-workspaces

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DRY_RUN=false
WIPE_KEEPER_WORKSPACES=false
ASSUME_YES=false

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=true ;;
    --wipe-workspaces) WIPE_KEEPER_WORKSPACES=true ;;
    --yes|-y) ASSUME_YES=true ;;
    -h|--help)
      echo "Usage: $0 [--dry-run] [--wipe-workspaces] [--yes]"
      exit 0
      ;;
    *)
      echo "error: unknown argument: ${arg}" >&2
      exit 1
      ;;
  esac
done

cd "${REPO_ROOT}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${REPO_ROOT}/.env"
    set +a
  else
    echo "error: DATABASE_URL not set and no .env found" >&2
    exit 1
  fi
fi

psql_exec() {
  docker compose exec -T postgres psql -U postgres -d tourbillon -v ON_ERROR_STOP=1 "$@"
}

echo "Starting postgres + redis if needed..."
docker compose up -d postgres redis >/dev/null

echo "Waiting for postgres..."
for _ in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

KEEPER_ROW="$(
  psql_exec -t -A -F '|' -c "
    SELECT c.id, c.name, c.slug,
           (SELECT count(*)::int FROM issues i WHERE i.company_id = c.id),
           (SELECT count(*)::int FROM agents a WHERE a.company_id = c.id)
    FROM companies c
    ORDER BY
      (SELECT count(*) FROM issues i WHERE i.company_id = c.id)
      + (SELECT count(*) FROM agents a WHERE a.company_id = c.id) ASC,
      c.created_at ASC
    LIMIT 1;
  "
)"

if [[ -z "${KEEPER_ROW}" ]]; then
  echo "error: no companies in database" >&2
  exit 1
fi

IFS='|' read -r KEEPER_ID KEEPER_NAME KEEPER_SLUG KEEPER_ISSUES KEEPER_AGENTS <<< "${KEEPER_ROW}"
KEEPER_ID="$(echo "${KEEPER_ID}" | tr -d '[:space:]')"

if [[ ! "${KEEPER_ID}" =~ ^[a-f0-9-]{36}$ ]]; then
  echo "error: invalid keeper company id: ${KEEPER_ID}" >&2
  exit 1
fi

psql_quote() {
  printf "'%s'" "${1//\'/\'\'}"
}
KEEPER_SQL="$(psql_quote "${KEEPER_ID}")"

echo ""
echo "Keeper company (smallest workload):"
echo "  id:     ${KEEPER_ID}"
echo "  name:   ${KEEPER_NAME}"
echo "  slug:   ${KEEPER_SLUG}"
echo "  issues: ${KEEPER_ISSUES}"
echo "  agents: ${KEEPER_AGENTS}"
echo ""

echo "Current counts:"
psql_exec -c "
  SELECT 'companies' AS t, count(*)::text FROM companies
  UNION ALL SELECT 'agents', count(*)::text FROM agents
  UNION ALL SELECT 'issues', count(*)::text FROM issues
  UNION ALL SELECT 'heartbeat_runs', count(*)::text FROM heartbeat_runs
  UNION ALL SELECT 'observability', count(*)::text FROM agent_observability_events
  UNION ALL SELECT 'llm_providers', count(*)::text FROM llm_providers
  ORDER BY t;
"

OTHER_COMPANY_IDS="$(
  psql_exec -t -A -c "SELECT id FROM companies WHERE id != ${KEEPER_SQL};"
)"

if [[ "${DRY_RUN}" == true ]]; then
  echo ""
  echo "Dry run — no changes made."
  if [[ -n "${OTHER_COMPANY_IDS}" ]]; then
    echo "Would delete companies:"
    echo "${OTHER_COMPANY_IDS}" | sed 's/^/  /'
  fi
  echo "Would strip operational data for keeper company ${KEEPER_ID}"
  echo "Would keep default llm_provider only, truncate mastra_* tables, flush Redis"
  exit 0
fi

if [[ "${ASSUME_YES}" != true ]]; then
  read -r -p "Proceed with strip-down? [y/N] " confirm
  if [[ "${confirm}" != "y" && "${confirm}" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

echo ""
echo "Truncating high-volume audit tables (all companies)..."
psql_exec -c "
  TRUNCATE agent_observability_events;
  TRUNCATE heartbeat_runs;
  TRUNCATE cost_events;
  TRUNCATE activity_log;
"

echo "Stripping operational data for keeper company..."
psql_exec -c "
  DELETE FROM approvals WHERE company_id = ${KEEPER_SQL};
  DELETE FROM routines WHERE company_id = ${KEEPER_SQL};
  DELETE FROM issues WHERE company_id = ${KEEPER_SQL};
  DELETE FROM projects WHERE company_id = ${KEEPER_SQL};
  DELETE FROM goals WHERE company_id = ${KEEPER_SQL};
  DELETE FROM agents WHERE company_id = ${KEEPER_SQL};

  UPDATE companies
  SET issue_counter = 0, spent_monthly_tokens = 0, updated_at = NOW()
  WHERE id = ${KEEPER_SQL};
"

echo "Deleting other companies..."
psql_exec -c "DELETE FROM companies WHERE id != ${KEEPER_SQL};"

echo "Trimming LLM providers (keep default only)..."
psql_exec -c "DELETE FROM llm_providers WHERE is_default = false;"

echo "Truncating mastra_* tables (if any)..."
psql_exec <<'SQL'
DO $$ DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'mastra_%'
  LOOP
    EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
    RAISE NOTICE 'truncated %', r.tablename;
  END LOOP;
END $$;
SQL

echo "Flushing Redis..."
docker compose exec -T redis redis-cli FLUSHDB >/dev/null

DATA_ROOT="${REPO_ROOT}/data"
if [[ -n "${OTHER_COMPANY_IDS}" ]]; then
  echo "Removing workspace dirs for deleted companies..."
  while IFS= read -r company_id; do
    [[ -z "${company_id}" ]] && continue
    rm -rf "${DATA_ROOT}/company-workspaces/${company_id}"
    rm -rf "${DATA_ROOT}/execution-workspaces/${company_id}"
    echo "  removed data/*/${company_id}"
  done <<< "${OTHER_COMPANY_IDS}"
fi

if [[ "${WIPE_KEEPER_WORKSPACES}" == true ]]; then
  echo "Removing keeper company workspace dirs..."
  rm -rf "${DATA_ROOT}/company-workspaces/${KEEPER_ID}"
  rm -rf "${DATA_ROOT}/execution-workspaces/${KEEPER_ID}"
  echo "  removed data/*/${KEEPER_ID}"
fi

echo ""
echo "Strip-down complete. Final counts:"
psql_exec -c "
  SELECT 'companies' AS t, count(*)::text FROM companies
  UNION ALL SELECT 'agents', count(*)::text FROM agents
  UNION ALL SELECT 'issues', count(*)::text FROM issues
  UNION ALL SELECT 'heartbeat_runs', count(*)::text FROM heartbeat_runs
  UNION ALL SELECT 'observability', count(*)::text FROM agent_observability_events
  UNION ALL SELECT 'llm_providers', count(*)::text FROM llm_providers
  ORDER BY t;
"

echo ""
echo "Keeper company: ${KEEPER_NAME} (${KEEPER_ID})"
echo "Open http://localhost:3002 and select this company at /select-company"
