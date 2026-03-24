-- Remove redundant index on GachaWallet.userId (userId already has @unique constraint)
DROP INDEX IF EXISTS "GachaWallet_userId_idx";
