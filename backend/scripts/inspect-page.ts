import { PrismaClient } from '@prisma/client';
import { Command } from 'commander';

const program = new Command();
program
  .argument('<wikidotId>', 'Wikidot page id', (v) => parseInt(v, 10))
  .parse(process.argv);

const [wikidotId] = program.args.map((v) => parseInt(v, 10));

async function main() {
  if (!Number.isFinite(wikidotId)) {
    throw new Error('Invalid wikidotId');
  }

  const prisma = new PrismaClient();

  const page = await prisma.page.findUnique({
    where: { wikidotId },
    select: {
      id: true,
      wikidotId: true,
      currentUrl: true,
      isDeleted: true,
      firstPublishedAt: true,
      createdAt: true
    }
  });

  console.log('Page:', page);

  const versions = await prisma.pageVersion.findMany({
    where: { pageId: page?.id ?? 0 },
    orderBy: { validFrom: 'desc' },
    select: {
      id: true,
      validFrom: true,
      validTo: true,
      rating: true,
      voteCount: true,
      title: true
    }
  });

  console.log('Versions:', versions);

  if (versions.length > 0) {
    const versionId = versions[0].id;
    const stats = await prisma.$queryRawUnsafe<any>(
      `SELECT
          COALESCE(SUM(direction),0) AS rating,
          COALESCE(SUM(CASE WHEN direction = 1 THEN 1 ELSE 0 END),0) AS upvotes,
          COALESCE(SUM(CASE WHEN direction = -1 THEN 1 ELSE 0 END),0) AS downvotes
         FROM "Vote"
        WHERE "pageVersionId" = ${versionId}`
    );
    console.log('Current version vote stats:', stats[0]);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
