#!/usr/bin/env tsx

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkMissingVersions() {
  console.log('🔍 检查缺少current version的页面...');
  
  // 查找特定的问题页面IDs
  const problemPageIds = [23790, 23615, 21658, 24254, 978];
  
  for (const pageId of problemPageIds) {
    console.log(`\n📄 检查页面 ID ${pageId}:`);
    
    // 查找页面基本信息
    const page = await prisma.page.findUnique({
      where: { id: pageId },
      include: {
        versions: {
          orderBy: { createdAt: 'desc' },
          take: 5
        }
      }
    });
    
    if (!page) {
      console.log(`❌ 页面 ${pageId} 不存在`);
      continue;
    }
    
    console.log(`  URL: ${page.url}`);
    console.log(`  总版本数: ${page.versions.length}`);
    
    // 查找当前版本 (validTo = null)
    const currentVersion = page.versions.find(v => v.validTo === null);
    if (currentVersion) {
      console.log(`  ✅ 有当前版本: ${currentVersion.id} (创建于 ${currentVersion.createdAt})`);
      console.log(`     isDeleted: ${currentVersion.isDeleted}`);
      console.log(`     title: ${currentVersion.title}`);
    } else {
      console.log(`  ❌ 没有当前版本 (validTo=null)`);
      console.log(`  最近的版本:`);
      page.versions.slice(0, 3).forEach((v, i) => {
        console.log(`    ${i+1}. ID ${v.id} (创建于 ${v.createdAt}) validTo: ${v.validTo} isDeleted: ${v.isDeleted}`);
      });
    }
  }
  
  // 统计总体情况
  console.log(`\n📊 总体统计:`);
  
  const totalPages = await prisma.page.count();
  const pagesWithoutCurrentVersion = await prisma.page.count({
    where: {
      versions: {
        none: {
          validTo: null
        }
      }
    }
  });
  
  console.log(`总页面数: ${totalPages}`);
  console.log(`缺少当前版本的页面数: ${pagesWithoutCurrentVersion}`);
  
  if (pagesWithoutCurrentVersion > 0) {
    console.log(`\n缺少当前版本的页面示例:`);
    const samplePages = await prisma.page.findMany({
      where: {
        versions: {
          none: {
            validTo: null
          }
        }
      },
      take: 10,
      include: {
        versions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });
    
    samplePages.forEach(page => {
      const lastVersion = page.versions[0];
      console.log(`  - ${page.id}: ${page.url} (最后版本: ${lastVersion?.createdAt || 'None'})`);
    });
  }
}

checkMissingVersions()
  .catch(console.error)
  .finally(() => prisma.$disconnect());