import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// 用户查询诊断脚本
class UserDiagnostic {
  constructor() {
    this.cromClient = new GraphQLClient(process.env.CROM_API_URL || 'https://apiv1.crom.avn.sh/graphql');
    this.results = {
      tests: [],
      recommendations: [],
      finalQuery: null
    };
  }

  async runDiagnostic() {
    console.log('🔍 开始用户查询诊断');
    console.log('=' .repeat(60));
    console.log(`目标站点: ${process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com'}`);
    console.log('');

    // 测试1: 基础用户查询（无过滤器）
    await this.testBasicUserQuery();

    // 测试2: 带过滤器的用户查询
    await this.testFilteredUserQuery();

    // 测试3: 不同过滤器变体
    await this.testFilterVariants();

    // 测试4: 检查schema文档
    await this.testSchemaIntrospection();

    // 生成诊断报告
    this.generateDiagnosticReport();
  }

  async testBasicUserQuery() {
    console.log('🧪 测试1: 基础用户查询（无过滤器）');
    
    try {
      const basicQuery = `
        query BasicUsers {
          searchUsers(query: "") {
            name
            wikidotInfo {
              displayName
              wikidotId
              unixName
            }
            statistics {
              rank
              totalRating
              meanRating
              pageCount
            }
          }
          rateLimit {
            cost
            remaining
            resetAt
          }
        }
      `;

      const result = await this.cromClient.request(basicQuery);
      
      const userCount = result.searchUsers.length;
      console.log(`✅ 成功: 找到 ${userCount.toLocaleString()} 个用户`);
      console.log(`💰 Rate Limit消耗: ${result.rateLimit.cost}`);
      
      if (userCount > 0) {
        console.log('📊 前5个用户示例:');
        result.searchUsers.slice(0, 5).forEach((user, i) => {
          console.log(`   ${i+1}. ${user.name} (${user.wikidotInfo?.displayName || 'N/A'}) - 排名: ${user.statistics?.rank || 'N/A'}`);
        });
      }

      this.results.tests.push({
        name: '基础用户查询',
        success: true,
        userCount: userCount,
        rateLimitCost: result.rateLimit.cost,
        sampleUsers: result.searchUsers.slice(0, 3)
      });

      console.log('');

    } catch (error) {
      console.log(`❌ 失败: ${error.message}`);
      this.results.tests.push({
        name: '基础用户查询',
        success: false,
        error: error.message
      });
    }
  }

  async testFilteredUserQuery() {
    console.log('🧪 测试2: 带anyBaseUrl过滤器的用户查询');
    
    try {
      const filteredQuery = `
        query FilteredUsers($filter: SearchUsersFilter) {
          searchUsers(query: "", filter: $filter) {
            name
            wikidotInfo {
              displayName
              wikidotId
              unixName
            }
            statistics {
              rank
              totalRating
              meanRating
              pageCount
            }
          }
          rateLimit {
            cost
            remaining
            resetAt
          }
        }
      `;

      const result = await this.cromClient.request(filteredQuery, {
        filter: {
          anyBaseUrl: [process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com']
        }
      });
      
      const userCount = result.searchUsers.length;
      console.log(`✅ 成功: 找到 ${userCount.toLocaleString()} 个用户`);
      console.log(`💰 Rate Limit消耗: ${result.rateLimit.cost}`);
      
      if (userCount > 0) {
        console.log('📊 前5个用户示例:');
        result.searchUsers.slice(0, 5).forEach((user, i) => {
          console.log(`   ${i+1}. ${user.name} (${user.wikidotInfo?.displayName || 'N/A'}) - 排名: ${user.statistics?.rank || 'N/A'}`);
        });
      } else {
        console.log('⚠️  警告: anyBaseUrl过滤器返回了0个用户');
        this.results.recommendations.push('anyBaseUrl过滤器可能过于严格，建议使用基础查询');
      }

      this.results.tests.push({
        name: '带anyBaseUrl过滤器查询',
        success: true,
        userCount: userCount,
        rateLimitCost: result.rateLimit.cost,
        filter: 'anyBaseUrl',
        sampleUsers: result.searchUsers.slice(0, 3)
      });

      console.log('');

    } catch (error) {
      console.log(`❌ 失败: ${error.message}`);
      this.results.tests.push({
        name: '带anyBaseUrl过滤器查询',
        success: false,
        error: error.message
      });
    }
  }

  async testFilterVariants() {
    console.log('🧪 测试3: 不同过滤器变体');
    
    const filterVariants = [
      {
        name: 'baseUrl (单数)',
        filter: { baseUrl: process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com' }
      },
      {
        name: 'baseUrls (复数)',
        filter: { baseUrls: [process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com'] }
      },
      {
        name: 'wikidotSite',
        filter: { wikidotSite: 'scp-wiki-cn' }
      }
    ];

    const testQuery = `
      query TestFilterVariant($filter: SearchUsersFilter) {
        searchUsers(query: "", filter: $filter) {
          name
        }
        rateLimit {
          cost
          remaining
        }
      }
    `;

    for (const variant of filterVariants) {
      try {
        console.log(`   测试过滤器: ${variant.name}`);
        const result = await this.cromClient.request(testQuery, {
          filter: variant.filter
        });

        const userCount = result.searchUsers.length;
        console.log(`   ✅ ${variant.name}: ${userCount.toLocaleString()} 用户`);

        this.results.tests.push({
          name: `过滤器变体: ${variant.name}`,
          success: true,
          userCount: userCount,
          rateLimitCost: result.rateLimit.cost,
          filter: variant.filter
        });

        // 等待避免Rate Limit
        await this.sleep(500);

      } catch (error) {
        console.log(`   ❌ ${variant.name}: ${error.message}`);
        this.results.tests.push({
          name: `过滤器变体: ${variant.name}`,
          success: false,
          error: error.message,
          filter: variant.filter
        });
      }
    }

    console.log('');
  }

  async testSchemaIntrospection() {
    console.log('🧪 测试4: 检查SearchUsersFilter schema');
    
    try {
      const introspectionQuery = `
        query IntrospectSearchUsersFilter {
          __type(name: "SearchUsersFilter") {
            name
            fields {
              name
              type {
                name
                ofType {
                  name
                }
              }
            }
          }
        }
      `;

      const result = await this.cromClient.request(introspectionQuery);
      
      if (result.__type) {
        console.log('✅ SearchUsersFilter 可用字段:');
        result.__type.fields.forEach(field => {
          const typeName = field.type.name || field.type.ofType?.name || 'Unknown';
          console.log(`   - ${field.name}: ${typeName}`);
        });

        this.results.tests.push({
          name: 'Schema introspection',
          success: true,
          availableFields: result.__type.fields.map(f => f.name)
        });
      } else {
        console.log('⚠️  无法获取SearchUsersFilter schema');
      }

      console.log('');

    } catch (error) {
      console.log(`❌ Schema检查失败: ${error.message}`);
      this.results.tests.push({
        name: 'Schema introspection',
        success: false,
        error: error.message
      });
    }
  }

  generateDiagnosticReport() {
    console.log('📋 诊断报告总结');
    console.log('=' .repeat(60));

    // 分析测试结果
    const successfulTests = this.results.tests.filter(t => t.success);
    const userCounts = successfulTests
      .filter(t => t.userCount !== undefined)
      .map(t => ({ name: t.name, count: t.userCount }));

    console.log('✅ 成功的测试:');
    successfulTests.forEach(test => {
      if (test.userCount !== undefined) {
        console.log(`   ${test.name}: ${test.userCount.toLocaleString()} 用户`);
      } else {
        console.log(`   ${test.name}: 成功`);
      }
    });

    console.log('');

    // 找出最佳查询方法
    const bestQuery = userCounts.reduce((best, current) => {
      return current.count > best.count ? current : best;
    }, { name: '无', count: 0 });

    console.log(`🏆 最佳查询方法: ${bestQuery.name} (${bestQuery.count.toLocaleString()} 用户)`);

    // 生成推荐的最终查询
    if (bestQuery.count > 0) {
      const bestTest = this.results.tests.find(t => t.name === bestQuery.name);
      
      if (bestTest.name === '基础用户查询') {
        this.results.finalQuery = {
          method: 'basic',
          description: '使用基础查询，不带过滤器',
          query: `
            query GetAllUsers {
              searchUsers(query: "") {
                name
                wikidotInfo {
                  displayName
                  wikidotId
                  unixName
                }
                statistics {
                  rank
                  totalRating
                  meanRating
                  pageCount
                  pageCountScp
                  pageCountTale
                  pageCountGoiFormat
                  pageCountArtwork
                  pageCountLevel
                  pageCountEntity
                  pageCountObject
                }
              }
              rateLimit {
                cost
                remaining
                resetAt
              }
            }
          `,
          variables: null
        };
      } else if (bestTest.filter) {
        this.results.finalQuery = {
          method: 'filtered',
          description: `使用过滤器: ${JSON.stringify(bestTest.filter)}`,
          query: `
            query GetFilteredUsers($filter: SearchUsersFilter) {
              searchUsers(query: "", filter: $filter) {
                name
                wikidotInfo {
                  displayName
                  wikidotId
                  unixName
                }
                statistics {
                  rank
                  totalRating
                  meanRating
                  pageCount
                  pageCountScp
                  pageCountTale
                  pageCountGoiFormat
                  pageCountArtwork
                  pageCountLevel
                  pageCountEntity
                  pageCountObject
                }
              }
              rateLimit {
                cost
                remaining
                resetAt
              }
            }
          `,
          variables: { filter: bestTest.filter }
        };
      }
    }

    console.log('');
    console.log('💡 建议:');
    
    if (this.results.finalQuery) {
      console.log(`   推荐使用: ${this.results.finalQuery.method} 方法`);
      console.log(`   描述: ${this.results.finalQuery.description}`);
    }

    this.results.recommendations.forEach(rec => {
      console.log(`   - ${rec}`);
    });

    // 保存诊断结果
    const reportPath = './user-diagnostic-report.json';
    fs.writeFileSync(reportPath, JSON.stringify(this.results, null, 2));
    console.log(`\n💾 详细诊断报告已保存到: ${reportPath}`);

    console.log('\n🎯 最终建议的用户查询代码:');
    if (this.results.finalQuery) {
      console.log('```javascript');
      console.log(`// ${this.results.finalQuery.description}`);
      console.log(`const result = await cromClient.request(\`${this.results.finalQuery.query.trim()}\`${this.results.finalQuery.variables ? ', ' + JSON.stringify(this.results.finalQuery.variables) : ''});`);
      console.log('```');
    } else {
      console.log('❌ 无法确定最佳查询方法，需要进一步调查');
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 运行诊断
async function runUserDiagnostic() {
  console.log('🌟 SCPPER-CN 用户查询诊断开始');
  console.log(`开始时间: ${new Date().toLocaleString()}`);
  console.log('');
  
  const diagnostic = new UserDiagnostic();
  await diagnostic.runDiagnostic();
  
  console.log('');
  console.log(`结束时间: ${new Date().toLocaleString()}`);
  console.log('🌟 用户查询诊断完成');
}

runUserDiagnostic().catch(console.error);