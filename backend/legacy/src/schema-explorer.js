import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// CROM GraphQL Schema 深度探索脚本
class CROMSchemaExplorer {
  constructor() {
    this.cromClient = new GraphQLClient(process.env.CROM_API_URL || 'https://apiv1.crom.avn.sh/graphql');
    this.findings = {
      userQueryMethods: [],
      userFields: [],
      alternativeApproaches: [],
      schemaInsights: []
    };
  }

  async exploreSchema() {
    console.log('🔍 CROM GraphQL Schema 深度探索');
    console.log('=' .repeat(70));
    console.log(`API端点: ${process.env.CROM_API_URL}`);
    console.log('');

    // 1. 探索根查询类型
    await this.exploreRootQueries();

    // 2. 深入分析用户相关类型
    await this.exploreUserTypes();

    // 3. 探索过滤器和参数
    await this.exploreFiltersAndArgs();

    // 4. 测试分页和限制参数
    await this.testPaginationLimits();

    // 5. 探索从页面数据中提取用户的可能性
    await this.exploreUserExtractionFromPages();

    // 6. 生成综合报告
    this.generateComprehensiveReport();
  }

  async exploreRootQueries() {
    console.log('🎯 探索根查询类型...');
    
    try {
      const rootQuery = `
        query ExploreRoot {
          __schema {
            queryType {
              name
              fields {
                name
                description
                args {
                  name
                  type {
                    name
                    kind
                    ofType {
                      name
                      kind
                    }
                  }
                  description
                }
                type {
                  name
                  kind
                  ofType {
                    name
                    kind
                  }
                }
              }
            }
          }
        }
      `;

      const result = await this.cromClient.request(rootQuery);
      const fields = result.__schema.queryType.fields;
      
      console.log('✅ 可用的根查询:');
      
      const userRelatedQueries = [];
      fields.forEach(field => {
        console.log(`   ${field.name}: ${field.type.name || field.type.ofType?.name}`);
        if (field.description) {
          console.log(`      ${field.description}`);
        }
        
        // 查找用户相关的查询
        if (field.name.toLowerCase().includes('user') || 
            field.description?.toLowerCase().includes('user') ||
            field.type.name?.toLowerCase().includes('user') ||
            field.type.ofType?.name?.toLowerCase().includes('user')) {
          userRelatedQueries.push({
            name: field.name,
            description: field.description,
            returnType: field.type.name || field.type.ofType?.name,
            args: field.args
          });
        }
      });

      console.log('\n👤 用户相关查询:');
      userRelatedQueries.forEach(query => {
        console.log(`   🔹 ${query.name} -> ${query.returnType}`);
        if (query.description) {
          console.log(`      描述: ${query.description}`);
        }
        if (query.args.length > 0) {
          console.log(`      参数: ${query.args.map(a => a.name).join(', ')}`);
        }
      });

      this.findings.userQueryMethods = userRelatedQueries;
      console.log('');

    } catch (error) {
      console.log(`❌ 根查询探索失败: ${error.message}`);
    }
  }

  async exploreUserTypes() {
    console.log('👤 探索用户相关类型...');
    
    const userTypeQueries = [
      { name: 'User', description: '用户类型' },
      { name: 'SearchUsersFilter', description: '用户搜索过滤器' },
      { name: 'UserStatistics', description: '用户统计' },
      { name: 'WikidotUserInfo', description: 'Wikidot用户信息' }
    ];

    for (const typeQuery of userTypeQueries) {
      try {
        console.log(`\n🔍 分析类型: ${typeQuery.name}`);
        
        const typeIntrospection = `
          query ExploreType($typeName: String!) {
            __type(name: $typeName) {
              name
              kind
              description
              fields {
                name
                type {
                  name
                  kind
                  ofType {
                    name
                    kind
                  }
                }
                description
              }
              inputFields {
                name
                type {
                  name
                  kind
                  ofType {
                    name
                    kind
                  }
                }
                description
              }
            }
          }
        `;

        const result = await this.cromClient.request(typeIntrospection, {
          typeName: typeQuery.name
        });

        if (result.__type) {
          const type = result.__type;
          console.log(`   ✅ ${type.name} (${type.kind})`);
          
          if (type.description) {
            console.log(`   📝 ${type.description}`);
          }

          if (type.fields) {
            console.log(`   📊 字段 (${type.fields.length}个):`);
            type.fields.forEach(field => {
              const typeName = field.type.name || field.type.ofType?.name || 'Unknown';
              console.log(`      - ${field.name}: ${typeName}`);
              if (field.description) {
                console.log(`        ${field.description}`);
              }
            });

            if (typeQuery.name === 'User') {
              this.findings.userFields = type.fields.map(f => ({
                name: f.name,
                type: f.type.name || f.type.ofType?.name,
                description: f.description
              }));
            }
          }

          if (type.inputFields) {
            console.log(`   🔧 输入字段 (${type.inputFields.length}个):`);
            type.inputFields.forEach(field => {
              const typeName = field.type.name || field.type.ofType?.name || 'Unknown';
              console.log(`      - ${field.name}: ${typeName}`);
              if (field.description) {
                console.log(`        ${field.description}`);
              }
            });
          }

        } else {
          console.log(`   ❌ 类型 ${typeQuery.name} 不存在`);
        }

        await this.sleep(100); // 避免频率限制

      } catch (error) {
        console.log(`   ❌ 类型 ${typeQuery.name} 探索失败: ${error.message}`);
      }
    }
  }

  async exploreFiltersAndArgs() {
    console.log('\n🔧 探索搜索过滤器和参数...');
    
    try {
      // 深入分析 searchUsers 查询的参数
      const searchUsersAnalysis = `
        query AnalyzeSearchUsers {
          __schema {
            queryType {
              fields(includeDeprecated: true) {
                name
                args {
                  name
                  type {
                    name
                    kind
                    ofType {
                      name
                      kind
                    }
                  }
                  description
                  defaultValue
                }
              }
            }
          }
        }
      `;

      const result = await this.cromClient.request(searchUsersAnalysis);
      const searchUsersField = result.__schema.queryType.fields.find(f => f.name === 'searchUsers');

      if (searchUsersField) {
        console.log('✅ searchUsers 查询参数分析:');
        searchUsersField.args.forEach(arg => {
          const typeName = arg.type.name || arg.type.ofType?.name || 'Unknown';
          console.log(`   - ${arg.name}: ${typeName}`);
          if (arg.description) {
            console.log(`     ${arg.description}`);
          }
          if (arg.defaultValue) {
            console.log(`     默认值: ${arg.defaultValue}`);
          }
        });

        // 尝试不同的参数组合
        await this.testSearchUsersVariants();
      }

    } catch (error) {
      console.log(`❌ 过滤器探索失败: ${error.message}`);
    }
  }

  async testSearchUsersVariants() {
    console.log('\n🧪 测试 searchUsers 不同参数组合...');
    
    const testCases = [
      {
        name: '空查询',
        variables: { query: "" }
      },
      {
        name: '通配符查询',
        variables: { query: "*" }
      },
      {
        name: 'CN站过滤器',
        variables: { 
          query: "",
          filter: { anyBaseUrl: ["http://scp-wiki-cn.wikidot.com"] }
        }
      },
      {
        name: '尝试更大的limit',
        variables: { 
          query: "",
          limit: 100  // 测试是否有隐藏的limit参数
        }
      },
      {
        name: '尝试offset参数',
        variables: { 
          query: "",
          offset: 0   // 测试是否有offset参数
        }
      }
    ];

    const baseQuery = `
      query TestSearchUsers($query: String!, $filter: SearchUsersFilter, $limit: Int, $offset: Int) {
        searchUsers(query: $query, filter: $filter) {
          name
          wikidotInfo {
            wikidotId
            displayName
          }
        }
        rateLimit {
          cost
          remaining
        }
      }
    `;

    for (const testCase of testCases) {
      try {
        console.log(`   🔬 测试: ${testCase.name}`);
        
        const result = await this.cromClient.request(baseQuery, testCase.variables);
        const userCount = result.searchUsers.length;
        
        console.log(`      结果: ${userCount} 用户, Rate Limit: ${result.rateLimit.cost}`);
        
        if (userCount > 5) {
          console.log(`      🎉 发现突破! ${testCase.name} 返回了 ${userCount} 用户`);
          this.findings.alternativeApproaches.push({
            method: testCase.name,
            variables: testCase.variables,
            userCount: userCount
          });
        }

        await this.sleep(1000); // 避免Rate Limit

      } catch (error) {
        console.log(`      ❌ ${testCase.name} 失败: ${error.message.split(':')[0]}`);
      }
    }
  }

  async testPaginationLimits() {
    console.log('\n📄 测试分页和限制参数...');
    
    try {
      // 测试是否存在分页参数
      const paginationTests = [
        { param: 'first', value: 50 },
        { param: 'last', value: 50 },
        { param: 'after', value: null },
        { param: 'before', value: null }
      ];

      for (const test of paginationTests) {
        try {
          const testQuery = `
            query TestPagination($${test.param}: ${test.param === 'first' || test.param === 'last' ? 'Int' : 'String'}) {
              searchUsers(query: "", ${test.param}: $${test.param}) {
                name
              }
            }
          `;

          // 只测试first参数，其他可能需要具体值
          if (test.param === 'first') {
            const result = await this.cromClient.request(testQuery, {
              [test.param]: test.value
            });

            console.log(`   ✅ ${test.param} 参数有效: ${result.searchUsers.length} 用户`);
            
            if (result.searchUsers.length > 5) {
              this.findings.alternativeApproaches.push({
                method: `${test.param} 参数`,
                userCount: result.searchUsers.length
              });
            }
          }

          await this.sleep(500);

        } catch (error) {
          console.log(`   ❌ ${test.param} 参数无效: ${error.message.split(':')[0]}`);
        }
      }

    } catch (error) {
      console.log(`❌ 分页测试失败: ${error.message}`);
    }
  }

  async exploreUserExtractionFromPages() {
    console.log('\n📊 探索从页面数据中提取用户信息...');
    
    try {
      // 分析我们已有的数据中能提取多少用户信息
      console.log('💡 分析策略:');
      console.log('   1. 从投票记录中提取所有userWikidotId和userName');
      console.log('   2. 从修订记录中提取用户信息');
      console.log('   3. 从页面创建者中提取用户信息');
      console.log('   4. 从贡献者信息中提取用户信息');

      // 模拟分析（基于已知数据结构）
      this.findings.alternativeApproaches.push({
        method: '从投票记录提取用户',
        description: '通过876,838条投票记录中的用户信息构建用户数据库',
        estimatedUsers: '预估2000-5000个独立用户',
        dataQuality: '包含wikidotId、userName，但缺少统计信息'
      });

      this.findings.alternativeApproaches.push({
        method: '从修订记录提取用户',
        description: '通过371,826条修订记录中的用户信息补充用户数据',
        estimatedUsers: '预估1000-3000个独立用户',
        dataQuality: '包含编辑活跃度信息'
      });

      this.findings.alternativeApproaches.push({
        method: '交叉引用构建完整用户档案',
        description: '结合投票、修订、创建等多源数据构建用户档案',
        estimatedUsers: '预估5000+个独立用户',
        dataQuality: '丰富的用户行为数据，可计算影响力指标'
      });

    } catch (error) {
      console.log(`❌ 用户提取分析失败: ${error.message}`);
    }
  }

  generateComprehensiveReport() {
    console.log('\n📋 综合报告');
    console.log('=' .repeat(70));

    // 用户查询方法总结
    console.log('🎯 发现的用户查询方法:');
    if (this.findings.userQueryMethods.length > 0) {
      this.findings.userQueryMethods.forEach(method => {
        console.log(`   ✅ ${method.name}: ${method.returnType}`);
      });
    } else {
      console.log('   ❌ 未发现额外的用户查询方法');
    }

    // 替代方案总结
    console.log('\n💡 用户数据获取替代方案:');
    if (this.findings.alternativeApproaches.length > 0) {
      this.findings.alternativeApproaches.forEach((approach, i) => {
        console.log(`   ${i + 1}. ${approach.method}`);
        if (approach.description) {
          console.log(`      ${approach.description}`);
        }
        if (approach.userCount) {
          console.log(`      用户数量: ${approach.userCount}`);
        }
        if (approach.estimatedUsers) {
          console.log(`      ${approach.estimatedUsers}`);
        }
        if (approach.dataQuality) {
          console.log(`      数据质量: ${approach.dataQuality}`);
        }
      });
    }

    // 最终建议
    console.log('\n🎯 最终建议:');
    
    const hasBreakthrough = this.findings.alternativeApproaches.some(a => a.userCount > 5);
    
    if (hasBreakthrough) {
      console.log('🎉 发现了突破5用户限制的方法!');
      const bestMethod = this.findings.alternativeApproaches
        .filter(a => a.userCount > 5)
        .sort((a, b) => b.userCount - a.userCount)[0];
      
      console.log(`💫 推荐方法: ${bestMethod.method} (${bestMethod.userCount} 用户)`);
    } else {
      console.log('📊 CROM API确实限制用户查询为5个用户');
      console.log('💡 建议采用数据挖掘方法:');
      console.log('   1. 从投票记录中提取所有独立用户ID');
      console.log('   2. 从修订记录中补充用户活跃度数据');
      console.log('   3. 通过页面创建者和贡献者信息丰富用户档案');
      console.log('   4. 构建基于行为的用户影响力评分系统');
    }

    // 保存详细报告
    const reportPath = './schema-exploration-report.json';
    fs.writeFileSync(reportPath, JSON.stringify(this.findings, null, 2));
    console.log(`\n💾 详细报告已保存: ${reportPath}`);

    // 数据挖掘脚本生成
    console.log('\n🔧 推荐的数据挖掘脚本:');
    console.log('```javascript');
    console.log('// 从现有数据中提取完整用户列表');
    console.log('async function extractUsersFromData(pages, voteRecords, revisions) {');
    console.log('  const users = new Map();');
    console.log('  ');
    console.log('  // 从投票记录提取');
    console.log('  voteRecords.forEach(vote => {');
    console.log('    if (!users.has(vote.userWikidotId)) {');
    console.log('      users.set(vote.userWikidotId, {');
    console.log('        wikidotId: vote.userWikidotId,');
    console.log('        name: vote.userName,');
    console.log('        voteCount: 0,');
    console.log('        upvotes: 0,');
    console.log('        downvotes: 0');
    console.log('      });');
    console.log('    }');
    console.log('    const user = users.get(vote.userWikidotId);');
    console.log('    user.voteCount++;');
    console.log('    vote.direction > 0 ? user.upvotes++ : user.downvotes++;');
    console.log('  });');
    console.log('  ');
    console.log('  return Array.from(users.values());');
    console.log('}');
    console.log('```');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 运行schema探索
async function runSchemaExploration() {
  console.log('🌟 CROM GraphQL Schema 深度探索开始');
  console.log(`开始时间: ${new Date().toLocaleString()}`);
  console.log('');
  
  const explorer = new CROMSchemaExplorer();
  await explorer.exploreSchema();
  
  console.log('');
  console.log(`结束时间: ${new Date().toLocaleString()}`);
  console.log('🌟 Schema探索完成');
}

runSchemaExploration().catch(console.error);