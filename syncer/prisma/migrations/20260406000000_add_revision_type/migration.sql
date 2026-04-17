-- AlterTable: add type column to RevisionRecord
-- This column was previously added via `prisma db push` without a migration.
-- If the column already exists, this is a no-op (IF NOT EXISTS).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'RevisionRecord' AND column_name = 'type'
  ) THEN
    ALTER TABLE "RevisionRecord" ADD COLUMN "type" TEXT;
  END IF;
END $$;
