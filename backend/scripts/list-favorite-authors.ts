#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

function getArg(name: string, def?: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.findIndex(a => a === `--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return def;
}

async function main() {
  const prisma = getPrismaClient();
  try {
    const wikidotIdStr = getArg('wikidotId');
    const limitStr = getArg('limit', '20');
    if (!wikidotIdStr) {
      console.error('Usage: list-favorite-authors --wikidotId <id> [--limit 20]');
      process.exitCode = 2;
      return;
    }
    const wikidotId = Number(wikidotIdStr);
    const limit = Math.max(1, Number(limitStr || 20) || 20);

    const rows = await prisma.$queryRaw<Array<{
      userId: number;
      displayName: string | null;
      wikidotId: number | null;
      uv: number;
      dv: number;
      totalVotes: number;
      lastVoteAt: Date | null;
    }>>`
      SELECT 
        uvi."toUserId" AS "userId",
        uTo."displayName",
        uTo."wikidotId",
        uvi."upvoteCount" AS uv,
        uvi."downvoteCount" AS dv,
        uvi."totalVotes",
        uvi."lastVoteAt"
      FROM "UserVoteInteraction" uvi
      JOIN "User" me ON me."wikidotId" = ${wikidotId}
      JOIN "User" uTo ON uTo.id = uvi."toUserId"
      WHERE uvi."fromUserId" = me.id
      ORDER BY uvi."upvoteCount" DESC, uvi."downvoteCount" ASC, uvi."totalVotes" DESC, uvi."lastVoteAt" DESC NULLS LAST
      LIMIT ${limit}
    `;

    console.table(rows.map(r => ({ userId: r.userId, displayName: r.displayName, wikidotId: r.wikidotId, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.totalVotes), lastVoteAt: r.lastVoteAt })));
  } catch (err) {
    console.error('Error listing favorite authors:', err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();



