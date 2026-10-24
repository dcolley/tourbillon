-- Reverses 0020_apr2_hitl.sql (APR-2: hitl v0 request/response data, reviewer events, link tokens).
-- Drizzle has no down migrations, so this is applied by hand when rolling back:
--   psql "$DATABASE_URL" -f packages/db/rollback/0020_apr2_hitl.down.sql
-- Drops hitl_events and hitl_link_tokens (every recorded reviewer event and /o/ link token) and the
-- five approvals columns added by 0020 (hitl_request, hitl_response, idempotency_key, deadline,
-- presented_at) with their two indexes. Legacy approval columns and rows are untouched. Approvals
-- already closed as answered, declined, cancelled or expired keep that status text but lose their
-- stored request and response. The journal row for 0020 in drizzle.__drizzle_migrations is removed
-- too. Run rollbacks newest first (see README.md in this folder).
DROP INDEX IF EXISTS "approvals_pending_deadline_idx";
DROP INDEX IF EXISTS "approvals_idempotency_uidx";
DROP TABLE IF EXISTS "hitl_link_tokens";
DROP TABLE IF EXISTS "hitl_events";
ALTER TABLE "approvals" DROP COLUMN IF EXISTS "presented_at";
ALTER TABLE "approvals" DROP COLUMN IF EXISTS "deadline";
ALTER TABLE "approvals" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "approvals" DROP COLUMN IF EXISTS "hitl_response";
ALTER TABLE "approvals" DROP COLUMN IF EXISTS "hitl_request";
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792861730365;
