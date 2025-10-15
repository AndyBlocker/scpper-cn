import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const startedAt = new Date();
  try {
    const count = await prisma.pageVersion.count();
    const finishedAt = new Date();
    console.log('=== PageVersion Count ===');
    console.log(`Total PageVersion rows: ${count.toLocaleString('en-US')}`);
    console.log(`Started:  ${startedAt.toISOString()}`);
    console.log(`Finished: ${finishedAt.toISOString()}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Failed to count PageVersion rows:', error);
  process.exit(1);
});
