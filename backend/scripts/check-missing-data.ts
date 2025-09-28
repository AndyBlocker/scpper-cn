import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

async function checkMissingData() {
  const prisma = getPrismaClient();
  
  try {
    console.log('=== Missing Data Analysis ===\n');
    
    // 1. Check pages with 0 stored counts but have actual data
    console.log('1. Checking pages with 0 stored counts but have actual votes/revisions...\n');
    
    // Pages with votes but voteCount = 0 or null
    const pagesWithMissingVoteCount = await prisma.$queryRaw<Array<{
      pageId: number;
      wikidotId: number;
      url: string;
      storedVoteCount: number | null;
      actualVoteCount: bigint;
    }>>`
      SELECT 
        p.id as "pageId",
        pv."wikidotId",
        p."currentUrl" as url,
        pv."voteCount" as "storedVoteCount",
        COUNT(v.id) as "actualVoteCount"
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      INNER JOIN "Vote" v ON v."pageVersionId" = pv.id
      WHERE COALESCE(pv."voteCount", 0) = 0
      GROUP BY p.id, pv."wikidotId", p."currentUrl", pv."voteCount"
      HAVING COUNT(v.id) > 100
      ORDER BY COUNT(v.id) DESC
      LIMIT 10;
    `;
    
    if (pagesWithMissingVoteCount.length > 0) {
      console.log('Pages with votes but voteCount = 0:');
      console.table(pagesWithMissingVoteCount.map(p => ({
        pageId: p.pageId,
        wikidotId: p.wikidotId,
        url: p.url.substring(p.url.lastIndexOf('/') + 1),
        storedCount: p.storedVoteCount || 0,
        actualCount: Number(p.actualVoteCount)
      })));
    }
    
    // Pages with revisions but revisionCount = 0 or null
    const pagesWithMissingRevisionCount = await prisma.$queryRaw<Array<{
      pageId: number;
      wikidotId: number;
      url: string;
      storedRevisionCount: number | null;
      actualRevisionCount: bigint;
    }>>`
      SELECT 
        p.id as "pageId",
        pv."wikidotId",
        p."currentUrl" as url,
        pv."revisionCount" as "storedRevisionCount",
        COUNT(r.id) as "actualRevisionCount"
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      INNER JOIN "Revision" r ON r."pageVersionId" = pv.id
      WHERE COALESCE(pv."revisionCount", 0) = 0
      GROUP BY p.id, pv."wikidotId", p."currentUrl", pv."revisionCount"
      HAVING COUNT(r.id) > 50
      ORDER BY COUNT(r.id) DESC
      LIMIT 10;
    `;
    
    if (pagesWithMissingRevisionCount.length > 0) {
      console.log('\nPages with revisions but revisionCount = 0:');
      console.table(pagesWithMissingRevisionCount.map(p => ({
        pageId: p.pageId,
        wikidotId: p.wikidotId,
        url: p.url.substring(p.url.lastIndexOf('/') + 1),
        storedCount: p.storedRevisionCount || 0,
        actualCount: Number(p.actualRevisionCount)
      })));
    }
    
    // 2. Check revision 0 issues
    console.log('\n2. Analyzing revision 0 (CREATE_PAGE) issues...\n');
    
    const revision0Analysis = await prisma.$queryRaw<Array<{
      pageId: number;
      wikidotId: number;
      url: string;
      hasRevision0: boolean;
      hasCreatePage: boolean;
      minRevisionId: number;
      revisionCount: bigint;
    }>>`
      SELECT 
        p.id as "pageId",
        pv."wikidotId",
        p."currentUrl" as url,
        EXISTS(SELECT 1 FROM "Revision" WHERE "pageVersionId" = pv.id AND "wikidotId" = 0) as "hasRevision0",
        EXISTS(SELECT 1 FROM "Revision" WHERE "pageVersionId" = pv.id AND type = 'PAGE_CREATED') as "hasCreatePage",
        MIN(r."wikidotId") as "minRevisionId",
        COUNT(r.id) as "revisionCount"
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
      GROUP BY p.id, pv.id, pv."wikidotId", p."currentUrl"
      HAVING COUNT(r.id) > 0 
        AND NOT EXISTS(SELECT 1 FROM "Revision" WHERE "pageVersionId" = pv.id AND "wikidotId" = 0)
      ORDER BY COUNT(r.id) DESC
      LIMIT 20;
    `;
    
    if (revision0Analysis.length > 0) {
      console.log('Pages missing revision 0:');
      console.table(revision0Analysis.map(p => ({
        pageId: p.pageId,
        wikidotId: p.wikidotId,
        url: p.url.substring(p.url.lastIndexOf('/') + 1),
        hasCreatePage: p.hasCreatePage,
        minRevisionId: p.minRevisionId,
        totalRevisions: Number(p.revisionCount)
      })));
    }
    
    // 3. Check specific pages mentioned in the error log
    console.log('\n3. Checking specific pages from error log...\n');
    
    const specificPages = [126020]; // pageVersion that had errors
    
    for (const pvId of specificPages) {
      const pageData = await prisma.pageVersion.findUnique({
        where: { id: pvId },
        include: {
          page: true,
          _count: {
            select: {
              votes: true,
              revisions: true
            }
          }
        }
      });
      
      if (pageData) {
        console.log(`PageVersion ${pvId}:`);
        console.log(`  Page: ${pageData.page.currentUrl}`);
        console.log(`  WikidotId: ${pageData.wikidotId}`);
        console.log(`  Stored voteCount: ${pageData.voteCount || 0}`);
        console.log(`  Actual votes: ${pageData._count.votes}`);
        console.log(`  Stored revisionCount: ${pageData.revisionCount || 0}`);
        console.log(`  Actual revisions: ${pageData._count.revisions}`);
        
        // Check for revision 0
        const hasRevision0 = await prisma.revision.findFirst({
          where: {
            pageVersionId: pvId,
            wikidotId: 0
          }
        });
        
        console.log(`  Has revision 0: ${hasRevision0 ? 'Yes' : 'No'}`);
      }
    }
    
    // 4. Summary of Phase C status
    console.log('\n4. Phase C Processing Status...\n');
    
    const phaseCStatus = await prisma.$queryRaw<Array<{
      status: string;
      count: bigint;
    }>>`
      SELECT 
        CASE 
          WHEN "needPhaseC" = false THEN 'Not needed'
          WHEN "donePhaseC" = true THEN 'Completed'
          WHEN "donePhaseC" = false THEN 'Pending'
        END as status,
        COUNT(*) as count
      FROM "DirtyPage"
      GROUP BY status
      ORDER BY count DESC;
    `;
    
    console.log('Phase C Status:');
    console.table(phaseCStatus.map(s => ({
      status: s.status,
      count: Number(s.count)
    })));
    
  } catch (error) {
    console.error('Error checking missing data:', error);
  } finally {
    await disconnectPrisma();
  }
}

checkMissingData();