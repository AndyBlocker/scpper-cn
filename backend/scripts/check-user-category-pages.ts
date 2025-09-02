#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

async function main() {
  const prisma = getPrismaClient();
  const wikidotId = Number(process.argv[2] || 3396110);
  const category = String(process.argv[3] || 'log-of-anomalous-items-cn');
  try {
    const user = await prisma.user.findFirst({ where: { wikidotId }, select: { id: true, wikidotId: true, displayName: true } });
    if (!user) {
      console.log(JSON.stringify({ error: 'NO_USER', wikidotId }));
      return;
    }
    const rows = await prisma.$queryRaw<Array<{ wikidotId: number; title: string | null; category: string | null; createdAt: Date; validTo: Date | null }>>`
      SELECT DISTINCT ON (pv."wikidotId")
        pv."wikidotId", pv.title, pv.category, pv."createdAt", pv."validTo"
      FROM "Attribution" a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      WHERE a."userId" = ${user.id}
      ORDER BY pv."wikidotId", pv."createdAt" DESC
    `;
    const filtered = rows.filter(r => r.category === category);
    console.log(JSON.stringify({ user, category, totalLatest: rows.length, matchCount: filtered.length, items: filtered.slice(0, 10) }, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await disconnectPrisma();
  }
}

void main();


