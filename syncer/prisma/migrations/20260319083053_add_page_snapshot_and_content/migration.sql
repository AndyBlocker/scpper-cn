-- CreateTable
CREATE TABLE "PageSnapshot" (
    "fullname" TEXT NOT NULL,
    "wikidotId" INTEGER,
    "title" TEXT,
    "rating" INTEGER NOT NULL DEFAULT 0,
    "votesCount" INTEGER NOT NULL DEFAULT 0,
    "commentsCount" INTEGER NOT NULL DEFAULT 0,
    "size" INTEGER NOT NULL DEFAULT 0,
    "revisionsCount" INTEGER NOT NULL DEFAULT 0,
    "parentFullname" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT,
    "createdAt" BIGINT,
    "updatedAt" BIGINT,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageSnapshot_pkey" PRIMARY KEY ("fullname")
);

-- CreateTable
CREATE TABLE "PageContentCache" (
    "fullname" TEXT NOT NULL,
    "wikidotId" INTEGER,
    "source" TEXT,
    "html" TEXT,
    "sourceLength" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fetchReason" TEXT NOT NULL,

    CONSTRAINT "PageContentCache_pkey" PRIMARY KEY ("fullname")
);

-- CreateTable
CREATE TABLE "RevisionRecord" (
    "id" SERIAL NOT NULL,
    "fullname" TEXT NOT NULL,
    "wikidotRevisionId" INTEGER,
    "revNo" INTEGER NOT NULL,
    "createdByName" TEXT,
    "createdByWikidotId" INTEGER,
    "createdAt" TIMESTAMP(3),
    "comment" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevisionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileRecord" (
    "id" SERIAL NOT NULL,
    "fullname" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncerState" (
    "task" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "pagesScanned" INTEGER NOT NULL DEFAULT 0,
    "pagesChanged" INTEGER NOT NULL DEFAULT 0,
    "eventsWritten" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncerState_pkey" PRIMARY KEY ("task")
);

-- CreateIndex
CREATE INDEX "PageSnapshot_wikidotId_idx" ON "PageSnapshot"("wikidotId");

-- CreateIndex
CREATE INDEX "PageSnapshot_scannedAt_idx" ON "PageSnapshot"("scannedAt");

-- CreateIndex
CREATE INDEX "PageContentCache_fetchedAt_idx" ON "PageContentCache"("fetchedAt");

-- CreateIndex
CREATE INDEX "RevisionRecord_fullname_idx" ON "RevisionRecord"("fullname");

-- CreateIndex
CREATE INDEX "RevisionRecord_detectedAt_idx" ON "RevisionRecord"("detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RevisionRecord_fullname_revNo_key" ON "RevisionRecord"("fullname", "revNo");

-- CreateIndex
CREATE INDEX "FileRecord_fullname_idx" ON "FileRecord"("fullname");

-- CreateIndex
CREATE UNIQUE INDEX "FileRecord_fullname_fileName_key" ON "FileRecord"("fullname", "fileName");
