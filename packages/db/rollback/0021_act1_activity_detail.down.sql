-- Reverses 0021_act1_activity_detail.sql (ACT-1: activity correlation id and lookup indexes).
-- Drizzle has no down migrations, so this is applied by hand when rolling back:
--   psql "$DATABASE_URL" -f packages/db/rollback/0021_act1_activity_detail.down.sql
-- Drops the three activity_log indexes added by 0021 and the correlation_id column. Every
-- activity row is kept; rows lose only the grouping key that tied rows from one action together
-- (the Activity view then shows them ungrouped). The journal row for 0021 in
-- drizzle.__drizzle_migrations is removed too. Run rollbacks newest first (see README.md in this
-- folder): roll back any later migration before this file, or `pnpm db:migrate` will skip 0021.
DROP INDEX IF EXISTS "activity_log_company_correlation_idx";
DROP INDEX IF EXISTS "activity_log_company_entity_idx";
DROP INDEX IF EXISTS "activity_log_company_created_idx";
ALTER TABLE "activity_log" DROP COLUMN IF EXISTS "correlation_id";
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792877744191;
