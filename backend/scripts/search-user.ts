#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

async function main() {
  const prisma = getPrismaClient();
  try {
    const name = process.argv.slice(2).join(' ');
    if (!name) {
      console.error('Usage: search-user <name-fragment>');
      process.exitCode = 2;
      return;
    }
    const rows = await prisma.$queryRaw<Array<{ id: number; wikidotId: number | null; displayName: string | null }>>`
      SELECT id, "wikidotId", "displayName"
      FROM "User"
      WHERE "displayName" ILIKE '%' || ${name} || '%'
      ORDER BY "displayName" ASC
      LIMIT 50
    `;
    console.table(rows);
  } catch (err) {
    console.error('Error searching users:', err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();



