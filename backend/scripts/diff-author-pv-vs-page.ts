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
    const limit = Math.max(1, Number(getArg('limit', '10') || '10') || 10);
    if (!wikidotIdStr || !authorsStr) {
      console.error('Usage: diff-author-pv-vs-page --wikidotId <id> --authors "name1,name2,..." [--limit 10]');
      process.exitCode = 2;
      return;
    }
    const wikidotId = Number(wikidotIdStr);
    const names = authorsStr.split(',').map(s => s.trim()).filter(Boolean);
    const valuesClause = names.map(n => `('${esc(n)}')`).join(', ');

    // Resolve target authors
    const targets = await prisma.$queryRawUnsafe<Array<{ id: number; wikidotId: number | null; displayName: string | null }>>(`
      WITH target_names(name) AS (
        VALUES ${valuesClause}
      )
      SELECT u.id, u."wikidotId", u."displayName"
      FROM target_names t
      LEFT JOIN "User" u ON u."displayName" = t.name
    `);
    console.log('\nTarget authors:');
    console.table(targets);
    const authorIds = targets.map(t => t.id).filter(Boolean);
    if (!authorIds.length) {
      console.log('No matching authors');
      return;
    }
    const idsList = authorIds.join(',');

    // Aggregate by three scopes
    const aggSql = (scope: 'current_pv' | 'current_page' | 'all') => `
      WITH me AS (
        SELECT id FROM "User" WHERE "wikidotId" = ${wikidotId}
      ), tgt AS (
        SELECT id FROM "User" WHERE id IN (${idsList})
      ), votes_join AS (
        SELECT 
          v."userId" AS from_user_id,
          a."userId" AS to_user_id,
          v.direction,
          v.timestamp,
          pv."pageId" AS page_id,
          pv.id AS vote_pv_id
        FROM "Vote" v
        JOIN me ON v."userId" = me.id
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        JOIN "Attribution" a ON a."pageVerId" = pv.id
        JOIN tgt ON tgt.id = a."userId"
        WHERE v.direction != 0
      )
      SELECT 
        vj.to_user_id AS "authorId",
        u."displayName",
        u."wikidotId",
        COUNT(*) FILTER (WHERE vj.direction = 1) AS uv,
        COUNT(*) FILTER (WHERE vj.direction = -1) AS dv,
        COUNT(*) AS total,
        MAX(vj.timestamp) AS "lastVoteAt"
      FROM votes_join vj
      JOIN "User" u ON u.id = vj.to_user_id
      ${scope === 'current_pv' ? 'JOIN "PageVersion" cpv ON cpv.id = vj.vote_pv_id AND cpv."validTo" IS NULL AND cpv."isDeleted" = false' : ''}
      ${scope === 'current_page' ? 'JOIN "PageVersion" cpv ON cpv."pageId" = vj.page_id AND cpv."validTo" IS NULL AND cpv."isDeleted" = false' : ''}
      GROUP BY vj.to_user_id, u."displayName", u."wikidotId"
      ORDER BY uv DESC, dv ASC, total DESC, "lastVoteAt" DESC NULLS LAST
      LIMIT ${limit}
    `;

    const [curPv, curPage, allVers] = await Promise.all([
      prisma.$queryRawUnsafe<Array<any>>(aggSql('current_pv')),
      prisma.$queryRawUnsafe<Array<any>>(aggSql('current_page')),
      prisma.$queryRawUnsafe<Array<any>>(aggSql('all'))
    ]);

    console.log('\nAggregates (current_pv):');
    console.table(curPv.map(r => ({ authorId: r.authorId, displayName: r.displayName, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.total) })));

    console.log('\nAggregates (current_page):');
    console.table(curPage.map(r => ({ authorId: r.authorId, displayName: r.displayName, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.total) })));

    console.log('\nAggregates (all_versions):');
    console.table(allVers.map(r => ({ authorId: r.authorId, displayName: r.displayName, uv: Number(r.uv), dv: Number(r.dv), total: Number(r.total) })));

    // Diff: all - current_page and current_page - current_pv per author
    function toMap(rows: any[]) {
      const m = new Map<number, any>();
      rows.forEach(r => m.set(Number(r.authorId), r));
      return m;
    }
    const mAll = toMap(allVers), mPage = toMap(curPage), mPv = toMap(curPv);
    const ids = new Set<number>([...mAll.keys(), ...mPage.keys(), ...mPv.keys()]);
    const diffs: Array<any> = [];
    ids.forEach(id => {
      const a = mAll.get(id) || { uv: 0, total: 0 };
      const p = mPage.get(id) || { uv: 0, total: 0 };
      const v = mPv.get(id) || { uv: 0, total: 0 };
      diffs.push({ authorId: id, displayName: (a.displayName || p.displayName || v.displayName), uv_all: Number(a.uv||0), uv_cur_page: Number(p.uv||0), uv_cur_pv: Number(v.uv||0), drop_page: Number(a.uv||0) - Number(p.uv||0), drop_pv: Number(p.uv||0) - Number(v.uv||0) });
    });
    diffs.sort((x,y)=> (y.drop_page+y.drop_pv) - (x.drop_page+x.drop_pv));
    console.log('\nDiff summary (uv): all -> current_page -> current_pv');
    console.table(diffs);

    // Sample pages where counted in all_versions but excluded in current_pv but still present in current_page
    const sampleSql = `
      WITH me AS (
        SELECT id FROM "User" WHERE "wikidotId" = ${wikidotId}
      ), tgt AS (
        SELECT id FROM "User" WHERE id IN (${idsList})
      ), votes_join AS (
        SELECT 
          v.timestamp,
          v.direction,
          pv."wikidotId" AS page_wid,
          pv.title,
          pv."pageId" AS page_id,
          pv.id AS vote_pv_id,
          a."userId" AS author_id
        FROM "Vote" v
        JOIN me ON v."userId" = me.id
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        JOIN "Attribution" a ON a."pageVerId" = pv.id
        JOIN tgt ON tgt.id = a."userId"
        WHERE v.direction != 0
      ), cur_page AS (
        SELECT DISTINCT "pageId" AS page_id FROM "PageVersion" WHERE "validTo" IS NULL AND "isDeleted" = false
      ), cur_pv AS (
        SELECT id AS pv_id FROM "PageVersion" WHERE "validTo" IS NULL AND "isDeleted" = false
      )
      SELECT 
        vj.author_id,
        u."displayName" AS author_name,
        vj.page_wid,
        vj.title,
        MAX(vj.timestamp) AS last_ts,
        BOOL_OR(vj.page_id IN (SELECT page_id FROM cur_page)) AS present_current_page,
        BOOL_OR(vj.vote_pv_id IN (SELECT pv_id FROM cur_pv)) AS present_current_pv
      FROM votes_join vj
      JOIN "User" u ON u.id = vj.author_id
      GROUP BY vj.author_id, u."displayName", vj.page_wid, vj.title
      HAVING BOOL_OR(vj.page_id IN (SELECT page_id FROM cur_page)) AND NOT BOOL_OR(vj.vote_pv_id IN (SELECT pv_id FROM cur_pv))
      ORDER BY last_ts DESC
      LIMIT ${limit}
    `;
    const samples = await prisma.$queryRawUnsafe<Array<any>>(sampleSql);
    console.log('\nSample pages counted in all/current_page but excluded by current_pv filter:');
    console.table(samples.map(s => ({ authorId: s.author_id, author: s.author_name, page: s.page_wid, title: s.title, last_ts: s.last_ts })));
  } catch (err) {
    console.error('Error diffing author interactions:', err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();


