import { getPrismaClient } from '../src/utils/db-connection.js';

async function main() {
  const widArg = process.argv[2] || '1459852673';
  const wikidotId = Number(widArg);
  if (!Number.isFinite(wikidotId)) {
    console.error('Usage: get-page-status <wikidotId>');
    process.exit(1);
  }

  const prisma = getPrismaClient();
  try {
    const page = await prisma.page.findUnique({
      where: { wikidotId },
      select: {
        id: true,
        wikidotId: true,
        url: true,
        currentUrl: true,
        isDeleted: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    let currentVersion: any = null;
    let lastRevision: any = null;
    if (page) {
      currentVersion = await prisma.pageVersion.findFirst({
        where: { pageId: page.id, validTo: null },
        orderBy: { validFrom: 'desc' },
        select: {
          id: true,
          isDeleted: true,
          validFrom: true,
          validTo: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (currentVersion) {
        lastRevision = await prisma.revision.findFirst({
          where: { pageVersionId: currentVersion.id },
          orderBy: { timestamp: 'desc' },
          select: { timestamp: true },
        });
      }
    }

    const staging = await prisma.pageMetaStaging.findUnique({
      where: { wikidotId },
      select: {
        url: true,
        title: true,
        isDeleted: true,
        lastSeenAt: true,
        rating: true,
        revisionCount: true,
        voteCount: true,
      },
    });

    const dirty = await prisma.dirtyPage.findMany({
      where: { wikidotId },
      orderBy: { detectedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        needPhaseB: true,
        needPhaseC: true,
        donePhaseB: true,
        donePhaseC: true,
        reasons: true,
        detectedAt: true,
      },
    });

    console.log(
      JSON.stringify(
        {
          page,
          currentVersion,
          lastRevision,
          staging,
          dirty,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


