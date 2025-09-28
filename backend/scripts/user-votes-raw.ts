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
    const mode = (getArg('mode', 'summary') || 'summary').toLowerCase();
    const limit = Math.max(1, Number(getArg('limit', '20') || '20') || 20);
    if (!wikidotIdStr) {
      console.error('Usage: user-votes-raw --wikidotId <id> [--mode summary|raw] [--limit 20]');
      process.exitCode = 2;
      return;
    }
    const wikidotId = Number(wikidotIdStr);

    if (mode === 'summary') {
      // Current-only aggregation (validTo IS NULL AND NOT isDeleted)
      const current = await prisma.$queryRaw<Array<{
        authorId: number;
        displayName: string | null;
        wikidotId: number | null;
        uv: number;
        dv: number;
        total: number;
        lastVoteAt: Date | null;
      }>>`
        WITH me AS (
          SELECT id FROM "User" WHERE "wikidotId" = ${wikidotId}
        )
        SELECT 
          a."userId" AS "authorId",
          u."displayName",
          u."wikidotId",
          COUNT(*) FILTER (WHERE v.direction = 1) AS uv,
          COUNT(*) FILTER (WHERE v.direction = -1) AS dv,
          COUNT(*) AS total,
          MAX(v.timestamp) AS "lastVoteAt"
        FROM "Vote" v
        JOIN me ON v."userId" = me.id
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        JOIN "Attribution" a ON a."pageVerId" = pv.id AND a.type = 'AUTHOR'
        JOIN "User" u ON u.id = a."userId"
        WHERE v.direction != 0
          AND pv."validTo" IS NULL
          AND pv."isDeleted" = false
        GROUP BY a."userId", u."displayName", u."wikidotId"
        ORDER BY uv DESC, dv ASC, total DESC, "lastVoteAt" DESC NULLS LAST
        LIMIT ${limit}
      `;

      console.log('\nTop authors (current-only, AUTHOR only):');
      console.table(current.map(r => ({ authorId: r.authorId, displayName: r.displayName, wikidotId: r.wikidotId, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.total), lastVoteAt: r.lastVoteAt })));

      // All versions aggregation (no validTo/isDeleted filter)
      const allVers = await prisma.$queryRaw<Array<{
        authorId: number;
        displayName: string | null;
        wikidotId: number | null;
        uv: number;
        dv: number;
        total: number;
        lastVoteAt: Date | null;
      }>>`
        WITH me AS (
          SELECT id FROM "User" WHERE "wikidotId" = ${wikidotId}
        )
        SELECT 
          a."userId" AS "authorId",
          u."displayName",
          u."wikidotId",
          COUNT(*) FILTER (WHERE v.direction = 1) AS uv,
          COUNT(*) FILTER (WHERE v.direction = -1) AS dv,
          COUNT(*) AS total,
          MAX(v.timestamp) AS "lastVoteAt"
        FROM "Vote" v
        JOIN me ON v."userId" = me.id
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        JOIN "Attribution" a ON a."pageVerId" = pv.id AND a.type = 'AUTHOR'
        JOIN "User" u ON u.id = a."userId"
        WHERE v.direction != 0
        GROUP BY a."userId", u."displayName", u."wikidotId"
        ORDER BY uv DESC, dv ASC, total DESC, "lastVoteAt" DESC NULLS LAST
        LIMIT ${limit}
      `;

      console.log('\nTop authors (all versions, AUTHOR only):');
      console.table(allVers.map(r => ({ authorId: r.authorId, displayName: r.displayName, wikidotId: r.wikidotId, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.total), lastVoteAt: r.lastVoteAt })));
    } else {
      // Raw rows
      const rows = await prisma.$queryRaw<Array<{
        timestamp: Date;
        direction: number;
        pageWikidotId: number | null;
        title: string | null;
        authors: any;
      }>>`
        WITH me AS (
          SELECT id FROM "User" WHERE "wikidotId" = ${wikidotId}
        )
        SELECT 
          v.timestamp,
          v.direction,
          pv."wikidotId" AS "pageWikidotId",
          pv.title,
          JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('userId', u.id, 'wikidotId', u."wikidotId", 'displayName', u."displayName", 'type', a.type)) FILTER (WHERE u.id IS NOT NULL) AS authors
        FROM "Vote" v
        JOIN me ON v."userId" = me.id
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        LEFT JOIN "Attribution" a ON a."pageVerId" = pv.id
        LEFT JOIN "User" u ON u.id = a."userId"
        WHERE v.direction != 0
        GROUP BY v.timestamp, v.direction, pv."wikidotId", pv.title
        ORDER BY v.timestamp DESC
        LIMIT ${limit}
      `;

      console.table(rows.map(r => ({ timestamp: r.timestamp, direction: r.direction, pageWikidotId: r.pageWikidotId, title: r.title, authors: r.authors })));
    }
  } catch (err) {
    console.error('Error dumping user votes:', err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();



