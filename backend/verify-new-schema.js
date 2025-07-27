#!/usr/bin/env node

import { PrismaClient } from '@prisma/client';

/**
 * 验证新Schema V2部署和数据导入结果
 */

const prisma = new PrismaClient();

async function verifyNewSchema() {
  console.log('🔍 验证Schema V2部署结果');
  console.log('='.repeat(50));

  try {
    // 1. 验证数据完整性
    console.log('📊 数据统计:');
    
    const [
      pageCount,
      urlMappingCount,
      voteRecordCount,
      revisionCount,
      attributionCount,
      alternateTitleCount,
      userCount,
      sourceVersionCount
    ] = await Promise.all([
      prisma.page.count(),
      prisma.urlMapping.count(),
      prisma.voteRecord.count(),
      prisma.revision.count(),
      prisma.attribution.count(),
      prisma.alternateTitle.count(),
      prisma.user.count(),
      prisma.sourceVersion.count()
    ]);

    console.log(`   页面: ${pageCount}`);
    console.log(`   URL映射: ${urlMappingCount}`);
    console.log(`   投票记录: ${voteRecordCount}`);
    console.log(`   修订记录: ${revisionCount}`);
    console.log(`   贡献记录: ${attributionCount}`);
    console.log(`   备用标题: ${alternateTitleCount}`);
    console.log(`   用户: ${userCount}`);
    console.log(`   源代码版本: ${sourceVersionCount}`);
    console.log('');

    // 2. 验证页面实例版本控制
    console.log('🔄 验证页面实例版本控制:');
    
    const pagesWithMultipleInstances = await prisma.$queryRaw`
      SELECT url, COUNT(*) as instances, MAX("instanceVersion") as latest_version
      FROM "Page"
      GROUP BY url
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 5
    `;
    
    console.log(`   具有多个实例的URL数量: ${pagesWithMultipleInstances.length}`);
    if (pagesWithMultipleInstances.length > 0) {
      console.log('   示例:');
      pagesWithMultipleInstances.forEach((row, i) => {
        console.log(`   ${i + 1}. ${row.url} - ${row.instances} 个实例，最新版本: ${row.latest_version}`);
      });
    }
    console.log('');

    // 3. 验证URL映射完整性
    console.log('🗺️  验证URL映射完整性:');
    
    const unmappedActivePages = await prisma.page.count({
      where: {
        isDeleted: false,
        urlMappings: {
          none: {}
        }
      }
    });
    
    console.log(`   未映射的活跃页面: ${unmappedActivePages}`);
    
    // 4. 验证外键关系
    console.log('🔗 验证外键关系:');
    
    const voteRecordsWithValidPages = await prisma.voteRecord.count({
      where: {
        page: {
          id: {
            gt: 0
          }
        }
      }
    });
    
    const revisionsWithValidPages = await prisma.revision.count({
      where: {
        page: {
          id: {
            gt: 0
          }
        }
      }
    });
    
    console.log(`   有效页面关联的投票记录: ${voteRecordsWithValidPages}/${voteRecordCount}`);
    console.log(`   有效页面关联的修订记录: ${revisionsWithValidPages}/${revisionCount}`);
    console.log('');

    // 5. 验证威尔逊分数等分析字段
    console.log('📈 验证分析字段:');
    
    const pagesWithWilsonScore = await prisma.page.count({
      where: {
        wilsonScore: {
          not: null
        }
      }
    });
    
    const activeUsers = await prisma.user.count({
      where: {
        isActive: true
      }
    });
    
    console.log(`   有威尔逊分数的页面: ${pagesWithWilsonScore}/${pageCount}`);
    console.log(`   活跃用户: ${activeUsers}/${userCount}`);
    console.log('');

    // 6. 验证新schema特性
    console.log('🆕 验证新Schema特性:');
    
    // 检查是否使用了ID主键
    const samplePage = await prisma.page.findFirst({
      select: { id: true, url: true, instanceVersion: true, urlInstanceId: true }
    });
    
    if (samplePage) {
      console.log(`   ✅ ID主键: ${samplePage.id}`);
      console.log(`   ✅ URL实例ID: ${samplePage.urlInstanceId}`);
      console.log(`   ✅ 实例版本: ${samplePage.instanceVersion}`);
    }
    
    // 检查源代码hash
    const pagesWithSourceHash = await prisma.page.count({
      where: {
        sourceHash: {
          not: null
        }
      }
    });
    
    console.log(`   ✅ 有源代码hash的页面: ${pagesWithSourceHash}`);
    console.log('');

    // 7. 性能测试
    console.log('⚡ 简单性能测试:');
    
    const start = Date.now();
    const randomPages = await prisma.page.findMany({
      take: 100,
      include: {
        voteRecords: {
          take: 5
        }
      },
      orderBy: {
        id: 'asc'
      }
    });
    const queryTime = Date.now() - start;
    
    console.log(`   查询100个页面及关联投票记录: ${queryTime}ms`);
    console.log('');

    // 8. 总结
    console.log('📋 验证总结:');
    const issues = [];
    
    if (unmappedActivePages > 0) {
      issues.push(`${unmappedActivePages} 个活跃页面缺少URL映射`);
    }
    
    if (voteRecordsWithValidPages < voteRecordCount) {
      issues.push(`${voteRecordCount - voteRecordsWithValidPages} 个投票记录缺少有效页面关联`);
    }
    
    if (issues.length === 0) {
      console.log('   ✅ 所有验证项目通过！');
      console.log('   🎉 Schema V2部署成功，数据完整性良好');
    } else {
      console.log('   ⚠️  发现以下问题:');
      issues.forEach((issue, i) => {
        console.log(`   ${i + 1}. ${issue}`);
      });
    }

  } catch (error) {
    console.error('❌ 验证过程中发生错误:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行验证
verifyNewSchema();