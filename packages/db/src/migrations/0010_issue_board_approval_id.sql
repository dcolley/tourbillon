-- AlterTable
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "board_approval_id" text;
