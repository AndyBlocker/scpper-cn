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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const prisma = getPrismaClient();
  try {
    const wikidotIdStr = getArg('wikidotId');
    if (!wikidotIdStr) {
      console.error('Usage: paged-user-relations-users --wikidotId <id> [--direction targets|sources] [--polarity liker|hater] [--batch 100] [--pages 10] [--sleep 200]');
      process.exitCode = 2;
      return;
    }
    const wikidotId = Number(wikidotIdStr);
    const directionInput = (getArg('direction', 'targets') || 'targets').toLowerCase();
    const direction = ['sources', 'source', 'from', 'incoming'].includes(directionInput) ? 'sources' : 'targets';
    const polInput = (getArg('polarity', 'liker') || 'liker').toLowerCase();
    const isHater = ['hater', 'haters', 'hate', 'down', 'dv', 'negative'].includes(polInput);
    const batch = Math.max(1, Number(getArg('batch', '100') || '100') || 100);
    const pages = Math.max(1, Number(getArg('pages', '10') || '10') || 10);
    const sleepMs = Math.max(0, Number(getArg('sleep', '100') || '100') || 0);

    const orderClause = isHater
      ? 'uvi."downvoteCount" DESC, uvi."upvoteCount" ASC, uvi."totalVotes" DESC, uvi."lastVoteAt" DESC NULLS LAST'
      : 'uvi."upvoteCount" DESC, uvi."downvoteCount" ASC, uvi."totalVotes" DESC, uvi."lastVoteAt" DESC NULLS LAST';

    console.log(`wikidotId=${wikidotId} direction=${direction} polarity=${isHater ? 'hater' : 'liker'} batch=${batch} pages=${pages}`);

    for (let page = 0; page < pages; page++) {
      const offset = page * batch;
      let sql: string;
      if (direction === 'sources') {
        sql = `
          SELECT 
            uvi."fromUserId" AS "userId",
            uFrom."displayName",
            uFrom."wikidotId",
            uvi."upvoteCount" AS uv,
            uvi."downvoteCount" AS dv,
            uvi."totalVotes",
            uvi."lastVoteAt"
          FROM "UserVoteInteraction" uvi
          JOIN "User" me ON me."wikidotId" = ${wikidotId}
          JOIN "User" uFrom ON uFrom.id = uvi."fromUserId"
          WHERE uvi."toUserId" = me.id
          ORDER BY ${orderClause}
          LIMIT ${batch} OFFSET ${offset}
        `;
      } else {
        sql = `
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
          ORDER BY ${orderClause}
          LIMIT ${batch} OFFSET ${offset}
        `;
      }

      const rows = await prisma.$queryRawUnsafe<Array<{
        userId: number;
        displayName: string | null;
        wikidotId: number | null;
        uv: number;
        dv: number;
        totalVotes: number;
        lastVoteAt: Date | null;
      }>>(sql);

      console.log(`\nPage ${page + 1}/${pages} (offset=${offset})`);
      if (!rows.length) {
        console.log('(no rows)');
        break;
      }
      console.table(rows.map(r => ({ userId: r.userId, displayName: r.displayName, wikidotId: r.wikidotId, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.totalVotes), lastVoteAt: r.lastVoteAt })));

      if (sleepMs > 0 && page + 1 < pages) {
        await sleep(sleepMs);
      }
    }
  } catch (err) {
    console.error('Error paging user relations:', err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();



