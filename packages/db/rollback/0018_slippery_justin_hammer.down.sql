-- Reverses 0018_slippery_justin_hammer.sql (PRV-1: per-company provider enablement).
-- Drizzle has no down migrations, so this is applied by hand when rolling back:
--   psql "$DATABASE_URL" -f packages/db/rollback/0018_slippery_justin_hammer.down.sql
-- Dropping the table returns every provider to enabled for every company (the pre-0018
-- behaviour). The journal row for 0018 in drizzle.__drizzle_migrations is removed too.
-- Run rollbacks newest first (see README.md in this folder): every later migration (0019 and
-- up) must be rolled back before this file. Otherwise a later `pnpm db:migrate` reports
-- success but skips 0018, because a newer journal row is still present, and the table is not
-- recreated. Rolled back in order, `pnpm db:migrate` re-applies 0018 and the later migrations.
DROP INDEX IF EXISTS "company_llm_providers_company_provider_uidx";
DROP TABLE IF EXISTS "company_llm_providers";
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792760315266;
