#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

async function main() {
  const prisma = getPrismaClient();
  try {
    console.log('Scanning global interactions diffs (all_versions vs current_page/current_pv)...');

    const allVers = await prisma.$queryRaw<Array<{ fromUserId: number; toUserId: number; uv: number; dv: number }>>`
      WITH base AS (
        SELECT v."userId" as from_user_id, a."userId" as to_user_id, v.direction
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE v."userId" IS NOT NULL AND a."userId" IS NOT NULL AND v."userId" <> a."userId" AND v.direction <> 0
      )
      SELECT from_user_id as "fromUserId",
             to_user_id   as "toUserId",
             COUNT(*) FILTER (WHERE direction = 1) as uv,
             COUNT(*) FILTER (WHERE direction = -1) as dv
      FROM base
      GROUP BY from_user_id, to_user_id
    `;

    const currentPv = await prisma.$queryRaw<Array<{ fromUserId: number; toUserId: number; uv: number; dv: number }>>`
      WITH base AS (
        SELECT v."userId" as from_user_id, a."userId" as to_user_id, v.direction
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE v."userId" IS NOT NULL AND a."userId" IS NOT NULL AND v."userId" <> a."userId" AND v.direction <> 0
          AND pv."validTo" IS NULL AND pv."isDeleted" = false
      )
      SELECT from_user_id as "fromUserId",
             to_user_id   as "toUserId",
             COUNT(*) FILTER (WHERE direction = 1) as uv,
             COUNT(*) FILTER (WHERE direction = -1) as dv
      FROM base
      GROUP BY from_user_id, to_user_id
    `;

    const currentPage = await prisma.$queryRaw<Array<{ fromUserId: number; toUserId: number; uv: number; dv: number }>>`
      WITH base AS (
        SELECT v."userId" as from_user_id, a."userId" as to_user_id, v.direction, pv."pageId" as page_id
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE v."userId" IS NOT NULL AND a."userId" IS NOT NULL AND v."userId" <> a."userId" AND v.direction <> 0
      ), cur_page AS (
        SELECT DISTINCT "pageId" AS page_id FROM "PageVersion" WHERE "validTo" IS NULL AND "isDeleted" = false
      )
      SELECT from_user_id as "fromUserId",
             to_user_id   as "toUserId",
             COUNT(*) FILTER (WHERE direction = 1) as uv,
             COUNT(*) FILTER (WHERE direction = -1) as dv
      FROM base b
      JOIN cur_page cp ON cp.page_id = b.page_id
      GROUP BY from_user_id, to_user_id
    `;

    function toMap(rows: Array<{ fromUserId: number; toUserId: number; uv: number; dv: number }>) {
      const m = new Map<string, { uv: number; dv: number }>();
      rows.forEach(r => m.set(`${r.fromUserId}:${r.toUserId}`, { uv: Number(r.uv), dv: Number(r.dv) }));
      return m;
    }
    const mAll = toMap(allVers);
    const mPv = toMap(currentPv);
    const mPage = toMap(currentPage);

    const keys = new Set<string>([...mAll.keys(), ...mPv.keys(), ...mPage.keys()]);
    let diffCount = 0;
    const samples: Array<{ key: string; uv_all: number; uv_cur_page: number; uv_cur_pv: number; dv_all: number; dv_cur_page: number; dv_cur_pv: number }> = [];

    for (const key of keys) {
      const a = mAll.get(key) || { uv: 0, dv: 0 };
      const p = mPage.get(key) || { uv: 0, dv: 0 };
      const v = mPv.get(key) || { uv: 0, dv: 0 };
      if (a.uv !== p.uv || a.dv !== p.dv || p.uv !== v.uv || p.dv !== v.dv) {
        diffCount++;
        if (samples.length < 50) {
          samples.push({ key, uv_all: a.uv, uv_cur_page: p.uv, uv_cur_pv: v.uv, dv_all: a.dv, dv_cur_page: p.dv, dv_cur_pv: v.dv });
        }
      }
    }

    console.log(`Total pairs (union): ${keys.size}`);
    console.log(`Pairs with diffs: ${diffCount}`);
    console.log('Sample diffs:');
    console.table(samples);
  } catch (err) {
    console.error('Error running global diff:', err);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();

