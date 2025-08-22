import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

async function checkRevisionCountDiff() {
  const prisma = getPrismaClient();
  
  try {
    console.log('=== Revision Count Difference Analysis ===\n');
    
    // 1. Check pages where stored count = actual - 1
    console.log('1. Pages where revisionCount = actual count - 1:\n');
    
    const pagesWithDiffOne = await prisma.$queryRaw<Array<{
      pageId: number;
      wikidotId: number;
      url: string;
      storedCount: number;
      actualCount: bigint;
      hasRevision0: boolean;
      hasPageCreated: boolean;
      minRevisionId: number;
      maxRevisionId: number;
    }>>`
      WITH revision_details AS (
        SELECT 
          pv.id as page_version_id,
          pv."pageId",
          pv."wikidotId",
          p."currentUrl" as url,
          pv."revisionCount" as stored_count,
          COUNT(r.id) as actual_count,
          EXISTS(SELECT 1 FROM "Revision" WHERE "pageVersionId" = pv.id AND "wikidotId" = 0) as has_revision_0,
          EXISTS(SELECT 1 FROM "Revision" WHERE "pageVersionId" = pv.id AND type = 'PAGE_CREATED') as has_page_created,
          MIN(r."wikidotId") as min_revision_id,
          MAX(r."wikidotId") as max_revision_id
        FROM "PageVersion" pv
        INNER JOIN "Page" p ON pv."pageId" = p.id
        LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
          AND pv."revisionCount" IS NOT NULL
        GROUP BY pv.id, pv."pageId", pv."wikidotId", p."currentUrl", pv."revisionCount"
      )
      SELECT 
        "pageId",
        "wikidotId",
        url,
        stored_count,
        actual_count,
        has_revision_0 as "hasRevision0",
        has_page_created as "hasPageCreated",
        min_revision_id as "minRevisionId",
        max_revision_id as "maxRevisionId"
      FROM revision_details
      WHERE stored_count = actual_count - 1
      ORDER BY actual_count DESC
      LIMIT 50;
    `;
    
    if (pagesWithDiffOne.length > 0) {
      console.log(`Found ${pagesWithDiffOne.length} pages (showing up to 50) where stored = actual - 1:\n`);
      console.table(pagesWithDiffOne.slice(0, 20).map(p => ({
        pageId: p.pageId,
        wikidotId: p.wikidotId,
        url: p.url.substring(p.url.lastIndexOf('/') + 1),
        stored: p.storedCount,
        actual: Number(p.actualCount),
        hasRev0: p.hasRevision0,
        hasPageCreated: p.hasPageCreated,
        minRevId: p.minRevisionId
      })));
      
      // Check pattern
      const withRev0 = pagesWithDiffOne.filter(p => p.hasRevision0).length;
      const withoutRev0 = pagesWithDiffOne.filter(p => !p.hasRevision0).length;
      const withPageCreated = pagesWithDiffOne.filter(p => p.hasPageCreated).length;
      
      console.log('\nPattern analysis:');
      console.log(`  Pages with revision 0: ${withRev0}`);
      console.log(`  Pages without revision 0: ${withoutRev0}`);
      console.log(`  Pages with PAGE_CREATED type: ${withPageCreated}`);
    }
    
    // 2. Get total count for this pattern
    console.log('\n2. Total count of pages with this pattern:\n');
    
    const totalCount = await prisma.$queryRaw<Array<{count: bigint}>>`
      WITH revision_counts AS (
        SELECT 
          pv.id,
          pv."revisionCount" as stored_count,
          COUNT(r.id) as actual_count
        FROM "PageVersion" pv
        LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
          AND pv."revisionCount" IS NOT NULL
        GROUP BY pv.id, pv."revisionCount"
      )
      SELECT COUNT(*) as count
      FROM revision_counts
      WHERE stored_count = actual_count - 1;
    `;
    
    console.log(`Total pages where revisionCount = actual - 1: ${totalCount[0]?.count || 0}`);
    
    // 3. Check distribution of differences
    console.log('\n3. Distribution of revision count differences:\n');
    
    const distribution = await prisma.$queryRaw<Array<{
      difference: number;
      count: bigint;
      percentage: number;
    }>>`
      WITH revision_diffs AS (
        SELECT 
          pv."revisionCount" - COUNT(r.id) as difference
        FROM "PageVersion" pv
        LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
        WHERE pv."validTo" IS NULL
          AND pv."revisionCount" IS NOT NULL
        GROUP BY pv.id, pv."revisionCount"
      ),
      diff_counts AS (
        SELECT 
          difference,
          COUNT(*) as count,
          SUM(COUNT(*)) OVER() as total
        FROM revision_diffs
        GROUP BY difference
      )
      SELECT 
        difference,
        count,
        ROUND((count::numeric / total * 100), 2) as percentage
      FROM diff_counts
      ORDER BY count DESC
      LIMIT 20;
    `;
    
    console.log('Difference distribution (stored - actual):');
    console.table(distribution.map(d => ({
      difference: d.difference,
      count: Number(d.count),
      percentage: `${d.percentage}%`
    })));
    
    // 4. Sample some specific cases
    console.log('\n4. Examining specific cases:\n');
    
    const samples = await prisma.pageVersion.findMany({
      where: {
        validTo: null,
        revisionCount: { not: null },
        wikidotId: { in: pagesWithDiffOne.slice(0, 3).map(p => p.wikidotId) }
      },
      include: {
        page: true,
        revisions: {
          orderBy: { wikidotId: 'asc' },
          take: 5
        }
      }
    });
    
    for (const sample of samples) {
      console.log(`\nPage: ${sample.page.currentUrl}`);
      console.log(`  WikidotId: ${sample.wikidotId}`);
      console.log(`  Stored revisionCount: ${sample.revisionCount}`);
      console.log(`  First 5 revisions:`);
      sample.revisions.forEach(r => {
        console.log(`    - Revision ${r.wikidotId}: ${r.type} (${new Date(r.timestamp).toISOString().split('T')[0]})`);
      });
    }
    
  } catch (error) {
    console.error('Error checking revision count differences:', error);
  } finally {
    await disconnectPrisma();
  }
}

checkRevisionCountDiff();