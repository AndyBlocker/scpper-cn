#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';

type CoverageRow = {
  pageId: number;
  wikidotId: number;
  url: string;
  versions: number;
  allVotes: number;
  currentVotes: number;
  votesCovered: boolean;
  allRevs: number;
  currentRevs: number;
  revsCovered: boolean;
};

async function main() {
  const prisma = getPrismaClient();
  try {
    console.log('=== Coverage Audit: current PageVersion vs all versions (per Page) ===');

    // Compute whether current version fully covers union of all versions' votes/revisions
    const rows = await prisma.$queryRaw<CoverageRow[]>`
      WITH current_pv AS (
        SELECT p.id AS page_id, p."wikidotId" AS wikidot_id, p."currentUrl" AS url, pv.id AS current_pv_id
        FROM "Page" p
        JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
      ),
      pv_counts AS (
        SELECT pv."pageId" AS page_id,
               COUNT(*)::int AS versions
        FROM "PageVersion" pv
        GROUP BY pv."pageId"
      ),
      all_votes AS (
        SELECT pv."pageId" AS page_id, COUNT(v.id)::int AS all_votes
        FROM "PageVersion" pv
        LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
        GROUP BY pv."pageId"
      ),
      current_votes AS (
        SELECT cpv.page_id, COUNT(v.id)::int AS current_votes
        FROM current_pv cpv
        LEFT JOIN "Vote" v ON v."pageVersionId" = cpv.current_pv_id
        GROUP BY cpv.page_id
      ),
      all_revs AS (
        SELECT pv."pageId" AS page_id, COUNT(r.id)::int AS all_revs
        FROM "PageVersion" pv
        LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
        GROUP BY pv."pageId"
      ),
      current_revs AS (
        SELECT cpv.page_id, COUNT(r.id)::int AS current_revs
        FROM current_pv cpv
        LEFT JOIN "Revision" r ON r."pageVersionId" = cpv.current_pv_id
        GROUP BY cpv.page_id
      )
      SELECT 
        cpv.page_id AS "pageId",
        cpv.wikidot_id AS "wikidotId",
        cpv.url AS url,
        pvc.versions AS versions,
        COALESCE(av.all_votes, 0) AS "allVotes",
        COALESCE(cv.current_votes, 0) AS "currentVotes",
        (COALESCE(cv.current_votes, 0) = COALESCE(av.all_votes, 0)) AS "votesCovered",
        COALESCE(ar.all_revs, 0) AS "allRevs",
        COALESCE(cr.current_revs, 0) AS "currentRevs",
        (COALESCE(cr.current_revs, 0) = COALESCE(ar.all_revs, 0)) AS "revsCovered"
      FROM current_pv cpv
      JOIN pv_counts pvc ON pvc.page_id = cpv.page_id
      LEFT JOIN all_votes av ON av.page_id = cpv.page_id
      LEFT JOIN current_votes cv ON cv.page_id = cpv.page_id
      LEFT JOIN all_revs ar ON ar.page_id = cpv.page_id
      LEFT JOIN current_revs cr ON cr.page_id = cpv.page_id
      WHERE pvc.versions > 1
      ORDER BY pvc.versions DESC, av.all_votes DESC
      LIMIT 200;
    `;

    const total = rows.length;
    const votesCovered = rows.filter(r => r.votesCovered).length;
    const revsCovered = rows.filter(r => r.revsCovered).length;

    console.log(`Pages checked (multi-version, limited to 200): ${total}`);
    console.log(`  Votes fully covered by current version: ${votesCovered}/${total}`);
    console.log(`  Revisions fully covered by current version: ${revsCovered}/${total}`);

    const notCovered = rows.filter(r => !(r.votesCovered && r.revsCovered)).slice(0, 20);
    if (notCovered.length) {
      console.log('\nSample not fully covered pages (up to 20):');
      console.table(notCovered.map(r => ({
        wid: r.wikidotId,
        slug: r.url.substring(r.url.lastIndexOf('/') + 1),
        versions: r.versions,
        votes: `${r.currentVotes}/${r.allVotes}`,
        revs: `${r.currentRevs}/${r.allRevs}`
      })));
    } else {
      console.log('\n✅ All sampled multi-version pages have full coverage in current version.');
    }

  } catch (err) {
    console.error('Error auditing coverage:', err);
  } finally {
    await disconnectPrisma();
  }
}

void main();


