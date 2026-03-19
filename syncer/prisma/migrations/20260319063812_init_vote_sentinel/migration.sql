-- CreateTable
CREATE TABLE "VoteSentinelCache" (
    "fullname" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "userName" TEXT,
    "direction" INTEGER NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoteSentinelCache_pkey" PRIMARY KEY ("fullname","userId")
);

-- CreateTable
CREATE TABLE "VoteChangeEvent" (
    "id" SERIAL NOT NULL,
    "fullname" TEXT NOT NULL,
    "userId" INTEGER,
    "userName" TEXT,
    "changeType" TEXT NOT NULL,
    "oldDirection" INTEGER,
    "newDirection" INTEGER,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoteChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VoteSentinelCache_fullname_idx" ON "VoteSentinelCache"("fullname");

-- CreateIndex
CREATE INDEX "VoteChangeEvent_fullname_detectedAt_idx" ON "VoteChangeEvent"("fullname", "detectedAt");

-- CreateIndex
CREATE INDEX "VoteChangeEvent_detectedAt_idx" ON "VoteChangeEvent"("detectedAt");

-- CreateIndex
CREATE INDEX "VoteChangeEvent_userId_detectedAt_idx" ON "VoteChangeEvent"("userId", "detectedAt");
