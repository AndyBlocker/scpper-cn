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

function esc(str: string) {
  return str.replace(/'/g, "''");
}

async function main() {
  const prisma = getPrismaClient();
  try {
    const wikidotIdStr = getArg('wikidotId');
    const authorsStr = getArg('authors');
    const limit = Math.max(1, Number(getArg('limit', '20') || '20') || 20);
    if (!wikidotIdStr || !authorsStr) {
      console.error('Usage: check-favorite-authors --wikidotId <id> --authors "name1,name2,..." [--limit 20]');
      process.exitCode = 2;
      return;
    }
    const wikidotId = Number(wikidotIdStr);
    const names = authorsStr.split(',').map(s => s.trim()).filter(Boolean);
    if (names.length === 0) {
      console.error('No author names provided');
      process.exitCode = 2;
      return;
    }

    const valuesClause = names.map(n => `('${esc(n)}')`).join(', ');

    // Resolve target authors to user ids by displayName exact match
    const targets = await prisma.$queryRawUnsafe<Array<{ id: number; wikidotId: number | null; displayName: string | null }>>(`
      WITH target_names(name) AS (
        VALUES ${valuesClause}
      )
      SELECT u.id, u."wikidotId", u."displayName"
      FROM target_names t
      LEFT JOIN "User" u ON u."displayName" = t.name
    `);

    console.log('\nTarget authors resolved:');
    console.table(targets);

    const authorIds = targets.map(t => t.id).filter(Boolean);
    if (authorIds.length === 0) {
      console.log('No matching authors found in DB.');
      return;
    }

    const idsList = authorIds.join(',');

    // Current-only (valid, AUTHOR only)
    const current = await prisma.$queryRawUnsafe<Array<{
      authorId: number;
      displayName: string | null;
      wikidotId: number | null;
      uv: number;
      dv: number;
      total: number;
      lastVoteAt: Date | null;
    }>>(`
      WITH me AS (
        SELECT id FROM "User" WHERE "wikidotId" = ${wikidotId}
      ), tgt AS (
        SELECT id FROM "User" WHERE id IN (${idsList})
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
      JOIN tgt ON tgt.id = a."userId"
      JOIN "User" u ON u.id = a."userId"
      WHERE v.direction != 0
        AND pv."validTo" IS NULL
        AND pv."isDeleted" = false
      GROUP BY a."userId", u."displayName", u."wikidotId"
      ORDER BY uv DESC, dv ASC, total DESC, "lastVoteAt" DESC NULLS LAST
      LIMIT ${limit}
    `);

    console.log('\nCurrent-only (AUTHOR):');
    console.table(current.map(r => ({ authorId: r.authorId, displayName: r.displayName, wikidotId: r.wikidotId, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.total), lastVoteAt: r.lastVoteAt })));

    // All versions, AUTHOR only
    const allVers = await prisma.$queryRawUnsafe<Array<{
      authorId: number;
      displayName: string | null;
      wikidotId: number | null;
      uv: number;
      dv: number;
      total: number;
      lastVoteAt: Date | null;
    }>>(`
      WITH me AS (
        SELECT id FROM "User" WHERE "wikidotId" = ${wikidotId}
      ), tgt AS (
        SELECT id FROM "User" WHERE id IN (${idsList})
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
      JOIN tgt ON tgt.id = a."userId"
      JOIN "User" u ON u.id = a."userId"
      WHERE v.direction != 0
      GROUP BY a."userId", u."displayName", u."wikidotId"
      ORDER BY uv DESC, dv ASC, total DESC, "lastVoteAt" DESC NULLS LAST
      LIMIT ${limit}
    `);

    console.log('\nAll versions (AUTHOR):');
    console.table(allVers.map(r => ({ authorId: r.authorId, displayName: r.displayName, wikidotId: r.wikidotId, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.total), lastVoteAt: r.lastVoteAt })));

    // All versions, any attribution type
    const allTypes = await prisma.$queryRawUnsafe<Array<{
      authorId: number;
      displayName: string | null;
      wikidotId: number | null;
      uv: number;
      dv: number;
      total: number;
      lastVoteAt: Date | null;
    }>>(`
      WITH me AS (
        SELECT id FROM "User" WHERE "wikidotId" = ${wikidotId}
      ), tgt AS (
        SELECT id FROM "User" WHERE id IN (${idsList})
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
      JOIN "Attribution" a ON a."pageVerId" = pv.id
      JOIN tgt ON tgt.id = a."userId"
      JOIN "User" u ON u.id = a."userId"
      WHERE v.direction != 0
      GROUP BY a."userId", u."displayName", u."wikidotId"
      ORDER BY uv DESC, dv ASC, total DESC, "lastVoteAt" DESC NULLS LAST
      LIMIT ${limit}
    `);

    console.log('\nAll versions (ANY attribution type):');
    console.table(allTypes.map(r => ({ authorId: r.authorId, displayName: r.displayName, wikidotId: r.wikidotId, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.total), lastVoteAt: r.lastVoteAt })));
  } catch (err) {
    console.error('Error checking favorite authors:', err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();



