-- CreateTable
CREATE TABLE "public"."Page" (
    "id" SERIAL NOT NULL,
    "url" TEXT NOT NULL,
    "urlKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PageVersion" (
    "id" SERIAL NOT NULL,
    "pageId" INTEGER NOT NULL,
    "wikidotId" INTEGER,
    "title" TEXT,
    "rating" INTEGER,
    "voteCount" INTEGER,
    "revisionCount" INTEGER,
    "textContent" TEXT,
    "source" TEXT,
    "tags" TEXT[],
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Revision" (
    "id" SERIAL NOT NULL,
    "pageVersionId" INTEGER NOT NULL,
    "wikidotId" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "comment" TEXT,
    "userId" INTEGER,

    CONSTRAINT "Revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Vote" (
    "id" SERIAL NOT NULL,
    "pageVersionId" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "direction" INTEGER NOT NULL,
    "userId" INTEGER,

    CONSTRAINT "Vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."User" (
    "id" SERIAL NOT NULL,
    "wikidotId" INTEGER,
    "displayName" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PageStats" (
    "id" SERIAL NOT NULL,
    "pageVersionId" INTEGER NOT NULL,
    "uv" INTEGER NOT NULL,
    "dv" INTEGER NOT NULL,
    "wilson95" DOUBLE PRECISION NOT NULL,
    "controversy" DOUBLE PRECISION NOT NULL,
    "likeRatio" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PageStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserStats" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "totalUp" INTEGER NOT NULL,
    "totalDown" INTEGER NOT NULL,
    "totalRating" INTEGER NOT NULL,
    "favTag" TEXT,

    CONSTRAINT "UserStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Page_url_key" ON "public"."Page"("url");

-- CreateIndex
CREATE UNIQUE INDEX "Revision_pageVersionId_wikidotId_key" ON "public"."Revision"("pageVersionId", "wikidotId");

-- CreateIndex
CREATE UNIQUE INDEX "User_wikidotId_key" ON "public"."User"("wikidotId");

-- CreateIndex
CREATE UNIQUE INDEX "PageStats_pageVersionId_key" ON "public"."PageStats"("pageVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "UserStats_userId_key" ON "public"."UserStats"("userId");

-- AddForeignKey
ALTER TABLE "public"."PageVersion" ADD CONSTRAINT "PageVersion_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "public"."Page"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Revision" ADD CONSTRAINT "Revision_pageVersionId_fkey" FOREIGN KEY ("pageVersionId") REFERENCES "public"."PageVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Revision" ADD CONSTRAINT "Revision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Vote" ADD CONSTRAINT "Vote_pageVersionId_fkey" FOREIGN KEY ("pageVersionId") REFERENCES "public"."PageVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Vote" ADD CONSTRAINT "Vote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PageStats" ADD CONSTRAINT "PageStats_pageVersionId_fkey" FOREIGN KEY ("pageVersionId") REFERENCES "public"."PageVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserStats" ADD CONSTRAINT "UserStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
