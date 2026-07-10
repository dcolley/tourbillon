-- AlterTable
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "plan_document_body" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "plan_document_revision_id" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "plan_document_updated_at" timestamp;
