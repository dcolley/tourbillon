DROP TABLE IF EXISTS "company_computer_sessions";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "has_computer";
ALTER TABLE "agents" DROP COLUMN IF EXISTS "has_computer";
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793441578581;
