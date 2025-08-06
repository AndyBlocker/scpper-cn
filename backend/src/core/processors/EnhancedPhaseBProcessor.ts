import { buildAliasQuery } from '../graphql/AliasQueryBuilder.js';
import { PointEstimator } from '../graphql/PointEstimator.js';
import { GraphQLClient } from '../client/GraphQLClient.js';
import { DatabaseStore } from '../store/DatabaseStore.js';
import { PageService } from '../../services/PageService.ts';
import { Logger } from '../../utils/Logger.js';
import {
  SIMPLE_PAGE_THRESHOLD,
  BUCKET_SOFT_LIMIT,
  MAX_FIRST
} from '../../config/RateLimitConfig.js';

let MAX_PACK_CNT = 20;

/**
 * Enhanced Phase B Processor with support for page rename handling
 */
export class EnhancedPhaseBProcessor {
  private client: GraphQLClient;
  private store: DatabaseStore;
  private pageService: PageService;

  constructor() {
    this.client = new GraphQLClient();
    this.store = new DatabaseStore();
    this.pageService = new PageService();
  }

  async run(fullSync = false) {
    Logger.info('=== Enhanced Phase B: Intelligent Page Processing ===');
    
    const BATCH_LIMIT = 5000;
    let round = 0, totalProcessed = 0;

    // Get total count of pages needing Phase B processing
    const totalPhaseBPages = await this.store.prisma.dirtyPage.count({
      where: { needPhaseB: true, donePhaseB: false }
    });
    
    Logger.info(`Enhanced Phase B: ${totalPhaseBPages} total pages need processing`);

    while (true) {
      // Get dirty pages that need Phase B processing
      const dirtyPages = await this.store.fetchDirtyPages('B', BATCH_LIMIT);
      
      if (dirtyPages.length === 0) {
        Logger.info(`Enhanced Phase B completed: ${totalProcessed}/${totalPhaseBPages} pages processed`);
        break;
      }
      
      round++;
      const roundProgressPercent = totalPhaseBPages > 0 ? (totalProcessed / totalPhaseBPages * 100).toFixed(1) : '0';
      Logger.info(`\n🔄 Enhanced Phase B Round ${round}: Processing ${dirtyPages.length} pages [Current: ${totalProcessed}/${totalPhaseBPages} = ${roundProgressPercent}%]`);
      
      // Categorize and process different types of dirty pages
      const { renamedPages, normalPages } = this.categorizeDirtyPages(dirtyPages);
      
      Logger.info(`   Renamed pages: ${renamedPages.length}, Normal pages: ${normalPages.length}`);
      
      let roundProcessedPages = 0;
      
      // First, handle page renames
      if (renamedPages.length > 0) {
        Logger.info(`🔄 Processing ${renamedPages.length} renamed pages...`);
        roundProcessedPages += await this.processRenamedPages(renamedPages);
      }
      
      // Then, handle normal pages with existing logic
      if (normalPages.length > 0) {
        Logger.info(`📄 Processing ${normalPages.length} normal pages...`);
        roundProcessedPages += await this.processNormalPages(normalPages);
      }

      const roundElapsedTime = Date.now() - Date.now(); // This would be tracked properly
      totalProcessed += roundProcessedPages;
      const finalRoundPercent = totalPhaseBPages > 0 ? (totalProcessed / totalPhaseBPages * 100).toFixed(1) : '0';
      Logger.info(`✅ Enhanced Phase B Round ${round} completed: ${roundProcessedPages} pages [${totalProcessed}/${totalPhaseBPages} = ${finalRoundPercent}%]`);
    }
    
    Logger.info(`✅ Enhanced Phase B fully completed: ${totalProcessed}/${totalPhaseBPages} pages processed across ${round} rounds`);
  }

  /**
   * Categorize dirty pages by their processing needs
   */
  private categorizeDirtyPages(dirtyPages: any[]) {
    const renamedPages: any[] = [];
    const normalPages: any[] = [];
    
    for (const dirtyPage of dirtyPages) {
      // Check if this is a URL change (rename) based on the reasons
      const isRename = dirtyPage.reasons.some((reason: string) => 
        reason.includes('URL_CHANGED') || reason.includes('url changed')
      );
      
      if (isRename) {
        renamedPages.push(dirtyPage);
      } else {
        normalPages.push(dirtyPage);
      }
    }
    
    return { renamedPages, normalPages };
  }

  /**
   * Process pages that have been renamed
   */
  private async processRenamedPages(renamedPages: any[]): Promise<number> {
    let processed = 0;
    
    for (const dirtyPage of renamedPages) {
      try {
        // Extract rename information from reasons
        const renameInfo = this.parseRenameInfo(dirtyPage);
        
        if (renameInfo) {
          // Handle the page rename using DatabaseStore method
          await this.store.handlePageRename({
            pageId: dirtyPage.pageId,
            oldUrl: renameInfo.oldUrl,
            newUrl: renameInfo.newUrl,
            preserveHistory: true
          });
          
          Logger.info(`✅ Processed rename: ${renameInfo.oldUrl} → ${renameInfo.newUrl}`);
        }
        
        // Continue with normal content processing for the renamed page
        await this.processSinglePage(dirtyPage);
        
        // Mark Phase B as done
        await this.store.prisma.dirtyPage.update({
          where: { pageId: dirtyPage.pageId },
          data: { donePhaseB: true }
        });
        
        processed++;
        
      } catch (error) {
        Logger.error(`❌ Failed to process renamed page ${dirtyPage.page?.url || dirtyPage.pageId}:`, error);
      }
    }
    
    return processed;
  }

  /**
   * Process normal pages (not renamed) using existing logic
   */
  private async processNormalPages(normalPages: any[]): Promise<number> {
    if (normalPages.length === 0) return 0;
    
    // Build URLs to process with cost estimation (existing logic)
    const urlsToProcess = [];
    for (const dirtyPage of normalPages) {
      const stagingData = await this.store.prisma.pageMetaStaging.findUnique({
        where: { url: dirtyPage.page.url }
      });
      
      const actualRevCount = stagingData?.revisionCount ?? 0;
      const actualVoteCount = stagingData?.voteCount ?? 0;
      
      const conservativeCost = 
        1 +  // wikidotPage base cost
        2 +  // attributions
        1 +  // source  
        1 +  // textContent
        Math.min(actualRevCount, MAX_FIRST) +   // actual revisions we'll fetch (max 100)
        Math.min(actualVoteCount, MAX_FIRST);   // actual votes we'll fetch (max 100)
      
      urlsToProcess.push({
        url: dirtyPage.page.url,
        estimatedCost: conservativeCost,
        pageId: dirtyPage.pageId,
        reasons: dirtyPage.reasons,
        actualRevisionCount: stagingData?.revisionCount ?? 0,
        actualVoteCount: stagingData?.voteCount ?? 0,
      });
    }
    
    // Process in batches (existing bucket logic)
    let processed = 0;
    let bucket = [];
    let bucketCost = 0;
    let cnt = 0;
    
    for (const page of urlsToProcess) {
      const c = page.estimatedCost;
      if (bucketCost + c > BUCKET_SOFT_LIMIT && bucket.length > 0 || cnt == MAX_PACK_CNT) {
        processed += await this._flushBucket(bucket);
        bucket = [];
        bucketCost = 0;
        cnt = 0;
      }
      bucket.push(page);
      bucketCost += c;
      cnt++;
    }
    
    if (bucket.length > 0) {
      processed += await this._flushBucket(bucket);
    }
    
    return processed;
  }

  /**
   * Process a single page (for renamed pages)
   */
  private async processSinglePage(dirtyPage: any) {
    const stagingData = await this.store.prisma.pageMetaStaging.findUnique({
      where: { url: dirtyPage.page.url }
    });
    
    if (!stagingData) {
      Logger.warn(`No staging data found for ${dirtyPage.page.url}, skipping content update`);
      return;
    }
    
    // Build a single-page query
    const singlePageQuery = [{
      url: dirtyPage.page.url,
      estimatedCost: 10, // Conservative estimate
      pageId: dirtyPage.pageId,
      actualRevisionCount: stagingData.revisionCount ?? 0,
      actualVoteCount: stagingData.voteCount ?? 0,
    }];
    
    await this._flushBucket(singlePageQuery);
  }

  /**
   * Parse rename information from dirty page reasons
   */
  private parseRenameInfo(dirtyPage: any): { oldUrl: string; newUrl: string } | null {
    try {
      // Look for current URL in the page record and staging URL in reasons
      const currentUrl = dirtyPage.page?.url;
      
      // For now, we'll need to look up the staging data to find the new URL
      // This is a simplified implementation - in a real scenario, we might store this info differently
      return null; // TODO: Implement proper rename info extraction
      
    } catch (error) {
      Logger.error('Failed to parse rename info:', error);
      return null;
    }
  }

  /**
   * Flush a bucket of pages (existing logic adapted)
   */
  private async _flushBucket(bucket: any[]): Promise<number> {
    if (!bucket.length) return 0;
    
    try {
      const pagesWithCounts = bucket.map(page => ({
        ...page,
        revisionCount: page.actualRevisionCount ?? 0,
        voteCount: page.actualVoteCount ?? 0
      }));
      
      const { query, variables } = buildAliasQuery(pagesWithCounts, {
        revisionLimit: MAX_FIRST,
        voteLimit: MAX_FIRST
      });
      
      Logger.info(`Processing batch of ${bucket.length} pages...`);
      
      const res = await this.client.request(query, variables);
      
      // Process each page result
      for (const page of bucket) {
        const aliasKey = this.pageService.getAliasKey(page.url);
        const pageData = res.data[aliasKey];
        
        if (pageData?.wikidotPage) {
          await this.store.append('phase1', pageData.wikidotPage);
          
          // Mark Phase B as done
          await this.store.prisma.dirtyPage.update({
            where: { pageId: page.pageId },
            data: { donePhaseB: true }
          });
        }
      }
      
      return bucket.length;
      
    } catch (error) {
      Logger.error('Failed to process bucket:', error);
      return 0;
    }
  }
}