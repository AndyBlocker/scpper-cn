import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// CROM GraphQL Schema 探索脚本
class SchemaExplorer {
  constructor() {
    // CROM GraphQL端点
    this.cromClient = new GraphQLClient('https://apiv2.crom.avn.sh/graphql');
    this.results = {
      introspection: null,
      sampleQueries: {},
      errors: [],
      comparisons: {
        v1vsv2: {}
      }
    };
  }

  async exploreSchema() {
    console.log('🔍 CROM GraphQL 架构探索开始');
    console.log('='.repeat(80));
    console.log(`🎯 端点: https://apiv2.crom.avn.sh/graphql`);
    console.log('');

    try {
      // 1. 获取完整schema
      await this.getIntrospectionSchema();
      
      // 2. 探索基本查询
      await this.testBasicQueries();
      
      // 3. 探索页面相关查询
      await this.testPageQueries();
      
      // 4. 探索用户相关查询
      await this.testUserQueries();
      
      // 5. 探索新功能
      await this.testNewFeatures();
      
      // 6. 对比v1和v2差异
      await this.compareV1vsV2();
      
      // 7. 生成迁移建议
      await this.generateMigrationPlan();
      
      // 8. 保存结果
      await this.saveExplorationResults();

    } catch (error) {
      console.error(`❌ 探索过程发生错误: ${error.message}`);
      this.results.errors.push({
        type: 'fatal_error',
        error: error.message,
        timestamp: new Date()
      });
    }
  }

  async getIntrospectionSchema() {
    console.log('📋 获取API v2完整schema...');
    
    const introspectionQuery = `
      query IntrospectionQuery {
        __schema {
          queryType { name }
          mutationType { name }
          subscriptionType { name }
          types {
            ...FullType
          }
          directives {
            name
            description
            locations
            args {
              ...InputValue
            }
          }
        }
      }

      fragment FullType on __Type {
        kind
        name
        description
        fields(includeDeprecated: true) {
          name
          description
          args {
            ...InputValue
          }
          type {
            ...TypeRef
          }
          isDeprecated
          deprecationReason
        }
        inputFields {
          ...InputValue
        }
        interfaces {
          ...TypeRef
        }
        enumValues(includeDeprecated: true) {
          name
          description
          isDeprecated
          deprecationReason
        }
        possibleTypes {
          ...TypeRef
        }
      }

      fragment InputValue on __InputValue {
        name
        description
        type { ...TypeRef }
        defaultValue
      }

      fragment TypeRef on __Type {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                    ofType {
                      kind
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      const result = await this.cromClient.request(introspectionQuery);
      this.results.introspection = result;
      
      console.log('✅ Schema获取成功');
      console.log(`📊 发现类型: ${result.__schema.types.length}`);
      
      // 分析主要类型
      const queryType = result.__schema.types.find(t => t.name === result.__schema.queryType.name);
      if (queryType) {
        console.log(`🔍 Query字段数量: ${queryType.fields.length}`);
        console.log(`📝 主要Query字段: ${queryType.fields.slice(0, 5).map(f => f.name).join(', ')}`);
      }
      
    } catch (error) {
      console.error(`❌ Schema获取失败: ${error.message}`);
      this.results.errors.push({
        type: 'introspection_error',
        error: error.message
      });
    }
  }

  async testBasicQueries() {
    console.log('\n🔧 测试基本查询功能...');
    
    const basicTests = [
      // 测试Rate Limit (如果还存在)
      {
        name: 'rateLimit',
        query: `query { rateLimit { cost remaining resetAt } }`
      },
      
      // 测试根级别字段
      {
        name: 'rootFields',
        query: `query { __schema { queryType { fields { name } } } }`
      }
    ];

    for (const test of basicTests) {
      try {
        console.log(`   测试: ${test.name}`);
        const result = await this.cromClient.request(test.query);
        this.results.sampleQueries[test.name] = {
          query: test.query,
          result: result,
          success: true
        };
        console.log(`   ✅ ${test.name} 成功`);
      } catch (error) {
        console.log(`   ❌ ${test.name} 失败: ${error.message}`);
        this.results.sampleQueries[test.name] = {
          query: test.query,
          error: error.message,
          success: false
        };
      }
    }
  }

  async testPageQueries() {
    console.log('\n📄 测试页面相关查询...');
    
    const pageTests = [
      // 测试pages查询是否还存在
      {
        name: 'pages_basic',
        query: `query { pages(first: 1) { edges { node { url } } } }`
      },
      
      // 测试page单个查询
      {
        name: 'page_single',
        query: `query { page(url: "http://scp-wiki-cn.wikidot.com/scp-001") { url title } }`
      },
      
      // 测试新的可能字段名
      {
        name: 'articles_test',
        query: `query { articles(first: 1) { edges { node { url } } } }`
      },
      
      // 测试documents
      {
        name: 'documents_test', 
        query: `query { documents(first: 1) { edges { node { url } } } }`
      }
    ];

    for (const test of pageTests) {
      try {
        console.log(`   测试: ${test.name}`);
        const result = await this.cromClient.request(test.query);
        this.results.sampleQueries[test.name] = {
          query: test.query,
          result: result,
          success: true
        };
        console.log(`   ✅ ${test.name} 成功`);
        
        // 如果成功，尝试获取更详细的信息
        if (test.name === 'pages_basic' && result.pages) {
          await this.explorePageStructure();
        }
      } catch (error) {
        console.log(`   ❌ ${test.name} 失败: ${error.message}`);
        this.results.sampleQueries[test.name] = {
          query: test.query,
          error: error.message,
          success: false
        };
      }
    }
  }

  async explorePageStructure() {
    console.log('   🔍 探索页面数据结构...');
    
    const pageStructureQuery = `
      query ExplorePageStructure {
        pages(first: 2, filter: { url: { startsWith: "http://scp-wiki-cn.wikidot.com" } }) {
          edges {
            node {
              url
              ... on Page {
                title
                wikidotId
                category
                rating
                voteCount
                createdAt
                revisionCount
                source
                textContent
                tags
                isPrivate
                thumbnailUrl
                
                createdBy {
                  name
                  displayName
                  wikidotId
                }
                
                parent {
                  url
                  title
                }
                
                votes {
                  timestamp
                  userWikidotId
                  direction
                  user { name }
                }
                
                revisions {
                  index
                  wikidotId
                  timestamp
                  type
                  userWikidotId
                  comment
                  user { name }
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

    try {
      const result = await this.cromClient.request(pageStructureQuery);
      this.results.sampleQueries['page_structure_detailed'] = {
        query: pageStructureQuery,
        result: result,
        success: true
      };
      console.log('   ✅ 页面结构探索成功');
    } catch (error) {
      console.log(`   ❌ 页面结构探索失败: ${error.message}`);
      this.results.sampleQueries['page_structure_detailed'] = {
        query: pageStructureQuery,
        error: error.message,
        success: false
      };
      
      // 尝试简化版本
      await this.trySimplifiedPageQuery();
    }
  }

  async trySimplifiedPageQuery() {
    console.log('   🔍 尝试简化的页面查询...');
    
    const simplifiedQuery = `
      query SimplifiedPage {
        pages(first: 1) {
          edges {
            node {
              url
              title
              rating
              voteCount
            }
          }
        }
      }
    `;

    try {
      const result = await this.cromClient.request(simplifiedQuery);
      this.results.sampleQueries['page_simplified'] = {
        query: simplifiedQuery,
        result: result,
        success: true
      };
      console.log('   ✅ 简化页面查询成功');
    } catch (error) {
      console.log(`   ❌ 简化页面查询也失败: ${error.message}`);
    }
  }

  async testUserQueries() {
    console.log('\n👤 测试用户相关查询...');
    
    const userTests = [
      {
        name: 'users_basic',
        query: `query { users(first: 1) { edges { node { name } } } }`
      },
      
      {
        name: 'user_single',
        query: `query { user(name: "MScarlet") { name displayName wikidotId } }`
      },
      
      {
        name: 'members_test',
        query: `query { members(first: 1) { edges { node { name } } } }`
      }
    ];

    for (const test of userTests) {
      try {
        console.log(`   测试: ${test.name}`);
        const result = await this.cromClient.request(test.query);
        this.results.sampleQueries[test.name] = {
          query: test.query,
          result: result,
          success: true
        };
        console.log(`   ✅ ${test.name} 成功`);
      } catch (error) {
        console.log(`   ❌ ${test.name} 失败: ${error.message}`);
        this.results.sampleQueries[test.name] = {
          query: test.query,
          error: error.message,
          success: false
        };
      }
    }
  }

  async testNewFeatures() {
    console.log('\n✨ 探索新功能...');
    
    // 从introspection结果中提取可能的新字段
    if (this.results.introspection) {
      const queryType = this.results.introspection.__schema.types.find(
        t => t.name === this.results.introspection.__schema.queryType.name
      );
      
      if (queryType) {
        console.log(`🔍 发现的Query字段:`);
        queryType.fields.forEach(field => {
          console.log(`   - ${field.name}: ${field.description || 'No description'}`);
        });
        
        // 测试一些可能的新字段
        const newFieldTests = queryType.fields
          .filter(f => !['pages', 'users', 'page', 'user', 'rateLimit'].includes(f.name))
          .slice(0, 5); // 只测试前5个
        
        for (const field of newFieldTests) {
          try {
            const testQuery = `query { ${field.name} }`;
            console.log(`   测试新字段: ${field.name}`);
            const result = await this.cromClient.request(testQuery);
            this.results.sampleQueries[`new_${field.name}`] = {
              query: testQuery,
              result: result,
              success: true
            };
            console.log(`   ✅ ${field.name} 可用`);
          } catch (error) {
            console.log(`   ❌ ${field.name} 失败: ${error.message.split('\n')[0]}`);
          }
        }
      }
    }
  }

  async compareV1vsV2() {
    console.log('\n🔄 对比API v1 vs v2差异...');
    
    // 这里可以总结主要差异
    const v1Fields = ['pages', 'users', 'page', 'user', 'rateLimit'];
    const v2Fields = this.results.introspection ? 
      this.results.introspection.__schema.types
        .find(t => t.name === this.results.introspection.__schema.queryType.name)
        ?.fields.map(f => f.name) || [] : [];
    
    this.results.comparisons.v1vsv2 = {
      v1Fields,
      v2Fields,
      removedFields: v1Fields.filter(f => !v2Fields.includes(f)),
      newFields: v2Fields.filter(f => !v1Fields.includes(f)),
      commonFields: v1Fields.filter(f => v2Fields.includes(f))
    };
    
    console.log(`📊 字段对比:`);
    console.log(`   V1字段: ${v1Fields.length}`);
    console.log(`   V2字段: ${v2Fields.length}`);
    console.log(`   移除字段: ${this.results.comparisons.v1vsv2.removedFields.join(', ') || '无'}`);
    console.log(`   新增字段: ${this.results.comparisons.v1vsv2.newFields.slice(0, 10).join(', ') || '无'}${this.results.comparisons.v1vsv2.newFields.length > 10 ? '...' : ''}`);
    console.log(`   保留字段: ${this.results.comparisons.v1vsv2.commonFields.join(', ') || '无'}`);
  }

  async generateMigrationPlan() {
    console.log('\n📋 生成迁移计划...');
    
    const migrationPlan = {
      urgentActions: [],
      codeChanges: [],
      testingNeeded: [],
      newOpportunities: []
    };
    
    // 基于探索结果生成建议
    if (this.results.sampleQueries.pages_basic?.success) {
      migrationPlan.codeChanges.push('✅ pages查询仍然可用，现有代码可能无需大改');
    } else {
      migrationPlan.urgentActions.push('❌ pages查询不可用，需要找到替代方案');
    }
    
    if (this.results.sampleQueries.users_basic?.success) {
      migrationPlan.codeChanges.push('✅ users查询仍然可用');
    } else {
      migrationPlan.urgentActions.push('❌ users查询不可用，需要更新用户获取逻辑');
    }
    
    // 检查rate limit
    if (this.results.sampleQueries.rateLimit?.success) {
      migrationPlan.codeChanges.push('✅ rateLimit查询仍然可用，频率控制代码可保留');
    } else {
      migrationPlan.urgentActions.push('⚠️ rateLimit查询可能变化，需要更新频率控制逻辑');
    }
    
    console.log('🚨 紧急行动:');
    migrationPlan.urgentActions.forEach(action => console.log(`   ${action}`));
    
    console.log('🔧 代码变更:');
    migrationPlan.codeChanges.forEach(change => console.log(`   ${change}`));
    
    this.results.migrationPlan = migrationPlan;
  }

  async saveExplorationResults() {
    console.log('\n💾 保存探索结果...');
    
    const filename = `apiv2-exploration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filepath = `./apiv2-exploration-results/${filename}`;
    
    // 确保目录存在
    if (!fs.existsSync('./apiv2-exploration-results')) {
      fs.mkdirSync('./apiv2-exploration-results', { recursive: true });
    }
    
    const explorationReport = {
      metadata: {
        timestamp: new Date().toISOString(),
        apiEndpoint: 'https://apiv2.crom.avn.sh/internal',
        explorationVersion: '1.0.0'
      },
      results: this.results,
      summary: {
        totalTests: Object.keys(this.results.sampleQueries).length,
        successfulTests: Object.values(this.results.sampleQueries).filter(q => q.success).length,
        failedTests: Object.values(this.results.sampleQueries).filter(q => !q.success).length,
        errors: this.results.errors.length
      },
      nextSteps: [
        '1. 分析成功的查询，更新现有代码',
        '2. 为失败的查询找到替代方案',
        '3. 测试新发现的功能',
        '4. 更新所有同步脚本到APIv2',
        '5. 进行完整的功能测试'
      ]
    };
    
    fs.writeFileSync(filepath, JSON.stringify(explorationReport, null, 2));
    
    console.log(`✅ 探索结果已保存: ${filename}`);
    console.log(`📊 文件大小: ${(fs.statSync(filepath).size / 1024).toFixed(2)} KB`);
    
    return filepath;
  }
}

// 运行Schema探索
async function runSchemaExploration() {
  const explorer = new SchemaExplorer();
  await explorer.exploreSchema();
}

export { SchemaExplorer };

if (import.meta.url === `file://${process.argv[1]}`) {
  runSchemaExploration().catch(console.error);
}