import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();

  try {
    const totalCurrent = await prisma.pageVersion.count({ where: { validTo: null } });
    const withAlternateTitle = await prisma.pageVersion.count({
      where: {
        validTo: null,
        alternateTitle: { not: null }
      }
    });

    console.log('Current PageVersions:', totalCurrent);
    console.log('With alternateTitle:', withAlternateTitle);

    const sample = await prisma.pageVersion.findMany({
      where: {
        validTo: null,
        alternateTitle: { not: null }
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        pageId: true,
        title: true,
        alternateTitle: true,
        updatedAt: true,
        page: {
          select: {
            currentUrl: true
          }
        }
      }
    });

    if (sample.length === 0) {
      console.log('No alternateTitle data found. Phase A may not have synced yet.');
    } else {
      console.log('\nLatest entries with alternateTitle:');
      for (const entry of sample) {
        console.log(
          `#${entry.id} pageId=${entry.pageId} url=${entry.page?.currentUrl ?? 'n/a'} title="${entry.title ?? ''}" alternateTitle="${entry.alternateTitle ?? ''}" updated=${entry.updatedAt.toISOString()}`
        );
      }
    }
  } catch (error) {
    console.error('Failed to inspect alternate titles:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Script error:', error);
  process.exitCode = 1;
});
