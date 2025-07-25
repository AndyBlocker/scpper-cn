import { ProductionSync } from './src/sync/production-sync.js';

async function verifyPageCompleteness() {
  console.log('🔍 验证页面数据完整性');
  console.log('='.repeat(60));
  
  const sync = new ProductionSync({ voteOnly: false });
  
  try {
    // 1. 获取API报告的总页面数
    await sync.fetchTotalPageCount();
    const expectedTotal = sync.progressState.totalPages;
    
    // 2. 加载现有的页面检查点
    const checkpoint = await sync.loadPageCheckpoint();
    if (!checkpoint) {
      console.log('❌ 未找到页面检查点，请先运行页面同步');
      return;
    }
    
    const currentTotal = checkpoint.totalProcessed;
    console.log(`📊 API报告总数: ${expectedTotal}`);
    console.log(`📊 当前已同步: ${currentTotal}`);
    
    if (currentTotal >= expectedTotal) {
      console.log('✅ 页面数据完整，无需补全');
      return;
    }
    
    const missing = expectedTotal - currentTotal;
    console.log(`⚠️  缺失页面: ${missing} 页`);
    
    if (missing > 100) {
      console.log('❌ 缺失页面过多，建议重新运行完整同步');
      return;
    }
    
    // 3. 尝试获取缺失的页面
    console.log('\n🔄 尝试获取缺失页面...');
    
    // 加载现有数据
    sync.data.pages = checkpoint.pages || [];
    sync.data.revisions = checkpoint.revisions || [];
    sync.data.attributions = checkpoint.attributions || [];
    sync.data.alternateTitles = checkpoint.alternateTitles || [];
    sync.stats.pagesProcessed = currentTotal;
    
    const existingUrls = new Set(sync.data.pages.map(p => p.url));
    console.log(`📋 已加载 ${existingUrls.size} 个现有页面URL`);
    
    // 尝试多种方法获取剩余页面
    let newPagesFound = 0;
    
    // 方法1: 使用较大的批次从头查询，过滤已存在的
    const batchSize = Math.min(100, missing * 3);
    console.log(`\n方法1: 批量查询 (批次大小: ${batchSize})`);
    
    const query = `
      query GetAllPages($filter: PageQueryFilter, $first: Int) {
        pages(filter: $filter, first: $first) {
          edges {
            node {
              url
              ... on WikidotPage {
                wikidotId
                title
                rating
                voteCount
                category
                tags
                createdAt
                revisionCount
                commentCount
                isHidden
                isUserPage
                thumbnailUrl
                source
                textContent
                
                alternateTitles {
                  title
                }
                
                revisions(first: 5) {
                  edges {
                    node {
                      wikidotId
                      timestamp
                      user {
                        ... on WikidotUser {
                          displayName
                          wikidotId
                          unixName
                        }
                      }
                      comment
                    }
                  }
                }
                
                createdBy {
                  ... on WikidotUser {
                    displayName
                    wikidotId
                    unixName
                  }
                }
                
                parent {
                  url
                }
                
                children {
                  url
                }
                
                attributions {
                  type
                  user {
                    ... on WikidotUser {
                      displayName
                      wikidotId
                      unixName
                    }
                  }
                  date
                  order
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;
    
    const variables = {
      filter: {
        onWikidotPage: {
          url: { startsWith: "http://scp-wiki-cn.wikidot.com" }
        }
      },
      first: batchSize
    };
    
    await sync.rateLimit();
    const result = await sync.cromClient.request(query, variables);
    
    if (result && result.pages.edges.length > 0) {
      console.log(`📥 API返回 ${result.pages.edges.length} 页`);
      
      for (const edge of result.pages.edges) {
        if (!existingUrls.has(edge.node.url)) {
          sync.processPageBasic(edge.node);
          newPagesFound++;
          console.log(`   ✅ 新增页面: ${edge.node.title}`);
        }
      }
    }
    
    // 4. 如果找到新页面，保存更新后的数据
    if (newPagesFound > 0) {
      console.log(`\n📊 找到 ${newPagesFound} 个新页面`);
      sync.stats.pagesProcessed += newPagesFound;
      
      const newTotal = sync.stats.pagesProcessed;
      console.log(`📊 更新后总数: ${newTotal}/${expectedTotal}`);
      
      // 保存新的检查点
      await sync.savePageCheckpoint(newTotal, null);
      console.log('💾 已保存更新后的检查点');
      
      if (newTotal >= expectedTotal) {
        console.log('✅ 页面数据现已完整！');
      } else {
        const stillMissing = expectedTotal - newTotal;
        console.log(`⚠️  仍缺失 ${stillMissing} 页，可能是API统计误差`);
      }
    } else {
      console.log('\n❌ 未找到新页面');
      console.log('可能原因:');
      console.log('  1. API总数统计有误差');
      console.log('  2. 某些页面在同步过程中被删除');
      console.log('  3. 权限限制导致无法访问某些页面');
      console.log('  4. API分页机制的边界问题');
    }
    
    // 5. 数据完整性验证
    console.log('\n🔬 数据完整性验证:');
    const uniqueUrls = new Set(sync.data.pages.map(p => p.url));
    const duplicates = sync.data.pages.length - uniqueUrls.size;
    
    console.log(`   总页面数: ${sync.data.pages.length}`);
    console.log(`   唯一URL数: ${uniqueUrls.size}`);
    console.log(`   重复页面: ${duplicates}`);
    console.log(`   修订记录: ${sync.data.revisions.length}`);
    console.log(`   归属记录: ${sync.data.attributions.length}`);
    console.log(`   备用标题: ${sync.data.alternateTitles.length}`);
    
    if (duplicates > 0) {
      console.log('⚠️  发现重复页面，建议检查数据');
    }
    
  } catch (error) {
    console.error(`❌ 验证失败: ${error.message}`);
    console.error(error.stack);
  }
}

verifyPageCompleteness().catch(console.error);