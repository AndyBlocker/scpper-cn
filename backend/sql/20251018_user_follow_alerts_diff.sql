DO LANGUAGE plpgsql 'BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = ''UserActivityType'') THEN
    EXECUTE ''CREATE TYPE "UserActivityType" AS ENUM (''''REVISION'''',''''ATTRIBUTION'''')'';
  END IF;
  BEGIN
    ALTER TYPE "UserActivityType" ADD VALUE ''ATTRIBUTION_REMOVED'';
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END';

ALTER TABLE "UserActivityAlert"
  ADD COLUMN IF NOT EXISTS "pageVersionId" INT NULL REFERENCES "PageVersion"(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_activity_follow_type_pagever
  ON "UserActivityAlert" ("followId", "type", "pageVersionId")
  WHERE "pageVersionId" IS NOT NULL;
