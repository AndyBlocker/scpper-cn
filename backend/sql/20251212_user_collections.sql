DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CollectionVisibility') THEN
    CREATE TYPE "CollectionVisibility" AS ENUM ('PRIVATE', 'PUBLIC');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "UserCollection" (
  id SERIAL PRIMARY KEY,
  "ownerId" INT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  visibility "CollectionVisibility" NOT NULL DEFAULT 'PRIVATE',
  description TEXT NULL,
  notes TEXT NULL,
  "coverImageUrl" TEXT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT FALSE,
  "publishedAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_collection_owner_slug"
  ON "UserCollection"("ownerId", slug);

CREATE INDEX IF NOT EXISTS "idx_collection_owner_visibility"
  ON "UserCollection"("ownerId", visibility);

CREATE INDEX IF NOT EXISTS "idx_collection_slug"
  ON "UserCollection"(slug);

CREATE TABLE IF NOT EXISTS "UserCollectionItem" (
  id SERIAL PRIMARY KEY,
  "collectionId" INT NOT NULL REFERENCES "UserCollection"(id) ON DELETE CASCADE,
  "pageId" INT NOT NULL REFERENCES "Page"(id) ON DELETE CASCADE,
  annotation TEXT NULL,
  "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_collection_item_page"
  ON "UserCollectionItem"("collectionId", "pageId");

CREATE INDEX IF NOT EXISTS "idx_collection_item_order"
  ON "UserCollectionItem"("collectionId", "order");

CREATE INDEX IF NOT EXISTS "idx_collection_item_page"
  ON "UserCollectionItem"("pageId");

CREATE TABLE IF NOT EXISTS "CollectionAccountOwner" (
  "accountId" TEXT PRIMARY KEY,
  "userId" INT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_collection_account_user"
  ON "CollectionAccountOwner"("userId");
