/**
 * 文件路径: src/sync/graphql-doc-explorer.js
 * 功能概述: CROM GraphQL API 文档探索器
 * 
 * 主要功能:
 * - 获取 GraphQL API 的完整内省文档
 * - 提取 WikidotPage 类型的详细字段信息
 * - 生成可用字段的准确列表和类型定义
 * - 验证字段的实际可用性
 * - 输出标准的 API 文档格式
 * 
 * 使用方式:
 * - npm run doc-explore 或 node src/sync/graphql-doc-explorer.js
 */

import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import path from 'path';

export class GraphQLDocExplorer {
  constructor() {
    this.client = new GraphQLClient('https://apiv2.crom.avn.sh/graphql');
    this.introspectionData = null;
    this.output = {
      types: {},
      queries: {},
      fields: {},
      validatedFields: {},
      errors: []
    };
  }

  async explore() {
    console.log('📚 CROM GraphQL API 文档探索');
    console.log('='.repeat(80));

    try {
      // 1. 获取完整的内省数据
      await this.fetchIntrospection();

      // 2. 解析类型定义
      await this.parseTypes();

      // 3. 专门分析 WikidotPage
      await this.analyzeWikidotPage();

      // 4. 验证关键字段
      await this.validateFields();

      // 5. 生成文档
      await this.generateDocumentation();

      console.log('\n✅ GraphQL API 文档探索完成');

    } catch (error) {
      console.error('❌ 文档探索失败:', error.message);
      this.output.errors.push({
        type: 'exploration_failed',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  async fetchIntrospection() {
    console.log('\n🔍 获取 GraphQL 内省数据...');

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

    const result = await this.client.request(introspectionQuery);
    this.introspectionData = result.__schema;
    
    console.log(`✅ 获取完成: ${this.introspectionData.types.length} 个类型`);
  }

  async parseTypes() {
    console.log('\n📋 解析类型定义...');

    // 找到所有重要的类型
    const importantTypes = [
      'Query', 'WikidotPage', 'Page', 'WikidotUser', 'User',
      'WikidotVoteRecordConnection', 'WikidotRevisionConnection',
      'PageAttribution', 'PageAlternateTitle'
    ];

    for (const typeName of importantTypes) {
      const type = this.introspectionData.types.find(t => t.name === typeName);
      if (type) {
        this.output.types[typeName] = {
          name: type.name,
          kind: type.kind,
          description: type.description,
          fields: type.fields?.map(field => ({
            name: field.name,
            description: field.description,
            type: this.formatType(field.type),
            isDeprecated: field.isDeprecated,
            deprecationReason: field.deprecationReason
          })) || []
        };
        console.log(`   ✅ ${typeName}: ${type.fields?.length || 0} 个字段`);
      } else {
        console.log(`   ❌ ${typeName}: 未找到`);
      }
    }
  }

  async analyzeWikidotPage() {
    console.log('\n🔍 深度分析 WikidotPage 类型...');

    const wikidotPageType = this.output.types.WikidotPage;
    if (!wikidotPageType) {
      console.log('❌ WikidotPage 类型未找到');
      return;
    }

    console.log(`📊 WikidotPage 总字段数: ${wikidotPageType.fields.length}`);

    // 按功能分类字段
    const fieldCategories = {
      '基础信息': ['url', 'wikidotId', 'title', 'category', 'tags'],
      '评分投票': ['rating', 'voteCount'],
      '时间相关': ['createdAt'],
      '计数统计': ['revisionCount', 'commentCount'],
      '内容相关': ['source', 'textContent', 'thumbnailUrl'],
      '状态标记': ['isHidden', 'isUserPage'],
      '关联数据': ['createdBy', 'parent', 'children', 'attributions', 'revisions', 'fuzzyVoteRecords', 'alternateTitles', 'accountVoteRecords']
    };

    const categorizedFields = {};
    const uncategorizedFields = [];

    for (const field of wikidotPageType.fields) {
      let categorized = false;
      
      for (const [category, fieldNames] of Object.entries(fieldCategories)) {
        if (fieldNames.includes(field.name)) {
          if (!categorizedFields[category]) categorizedFields[category] = [];
          categorizedFields[category].push(field);
          categorized = true;
          break;
        }
      }

      if (!categorized) {
        uncategorizedFields.push(field);
      }
    }

    // 输出分类结果
    for (const [category, fields] of Object.entries(categorizedFields)) {
      console.log(`\n📂 ${category}:`);
      fields.forEach(field => {
        const deprecated = field.isDeprecated ? ' (已弃用)' : '';
        console.log(`   ✅ ${field.name}: ${field.type}${deprecated}`);
        if (field.description) {
          console.log(`      ${field.description}`);
        }
      });
    }

    if (uncategorizedFields.length > 0) {
      console.log(`\n❓ 未分类字段:`);
      uncategorizedFields.forEach(field => {
        console.log(`   ? ${field.name}: ${field.type}`);
        if (field.description) {
          console.log(`     ${field.description}`);
        }
      });
    }

    this.output.fields.WikidotPage = {
      categorized: categorizedFields,
      uncategorized: uncategorizedFields,
      total: wikidotPageType.fields.length
    };
  }

  async validateFields() {
    console.log('\n🧪 验证字段实际可用性...');

    const criticalFields = [
      'url', 'wikidotId', 'title', 'category', 'tags',
      'rating', 'voteCount', 'revisionCount', 'commentCount',
      'createdAt', 'source', 'textContent', 'thumbnailUrl',
      'isHidden', 'isUserPage', 'createdBy', 'attributions',
      'revisions', 'fuzzyVoteRecords', 'alternateTitles'
    ];

    // 测试基础字段
    const basicTestQuery = `
      query ValidateBasicFields {
        pages(first: 1, filter: { onWikidotPage: { url: { startsWith: "http://scp-wiki-cn.wikidot.com" } } }) {
          edges {
            node {
              url
              ... on WikidotPage {
                wikidotId
                title
                rating
                voteCount
                createdAt
                revisionCount
                commentCount
                source
                isHidden
                isUserPage
              }
            }
          }
        }
      }
    `;

    try {
      const result = await this.client.request(basicTestQuery);
      console.log('✅ 基础字段验证通过');
      
      const samplePage = result.pages.edges[0]?.node;
      if (samplePage) {
        console.log('📋 示例数据:');
        console.log(`   标题: ${samplePage.title}`);
        console.log(`   评分: ${samplePage.rating}`);
        console.log(`   投票数: ${samplePage.voteCount}`);
        console.log(`   修订数: ${samplePage.revisionCount}`);
        console.log(`   评论数: ${samplePage.commentCount}`);
      }

      this.output.validatedFields = {
        basic: {
          success: true,
          tested: ['wikidotId', 'title', 'rating', 'voteCount', 'createdAt', 'revisionCount', 'commentCount', 'source', 'isHidden', 'isUserPage'],
          sampleData: samplePage
        }
      };

    } catch (error) {
      console.log(`❌ 基础字段验证失败: ${error.message.split('\n')[0]}`);
      this.output.validatedFields.basic = {
        success: false,
        error: error.message
      };
    }

    // 测试复杂字段（关联数据）
    const complexTestQuery = `
      query ValidateComplexFields {
        pages(first: 1, filter: { onWikidotPage: { url: { startsWith: "http://scp-wiki-cn.wikidot.com" } } }) {
          edges {
            node {
              url
              ... on WikidotPage {
                createdBy {
                  ... on WikidotUser {
                    displayName
                    wikidotId
                  }
                }
                attributions {
                  type
                  user {
                    displayName
                  }
                }
                alternateTitles {
                  title
                }
              }
            }
          }
        }
      }
    `;

    try {
      const result = await this.client.request(complexTestQuery);
      console.log('✅ 复杂字段验证通过');
      
      this.output.validatedFields.complex = {
        success: true,
        tested: ['createdBy', 'attributions', 'alternateTitles']
      };

    } catch (error) {
      console.log(`❌ 复杂字段验证失败: ${error.message.split('\n')[0]}`);
      this.output.validatedFields.complex = {
        success: false,
        error: error.message
      };
    }
  }

  formatType(type) {
    if (type.kind === 'NON_NULL') {
      return `${this.formatType(type.ofType)}!`;
    } else if (type.kind === 'LIST') {
      return `[${this.formatType(type.ofType)}]`;
    } else {
      return type.name || 'Unknown';
    }
  }

  async generateDocumentation() {
    console.log('\n📝 生成 API 文档...');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `crom-graphql-api-doc-${timestamp}.json`;
    const filepath = path.join('./production-data', filename);

    // 确保目录存在
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 保存完整文档
    fs.writeFileSync(filepath, JSON.stringify(this.output, null, 2));

    // 生成 CLAUDE.md 格式的文档片段
    const claudeMdContent = this.generateClaadeMdFormat();
    const mdFilepath = path.join('./production-data', `wikidot-page-fields-${timestamp}.md`);
    fs.writeFileSync(mdFilepath, claudeMdContent);

    console.log(`✅ 完整文档已保存: ${filename}`);
    console.log(`📋 CLAUDE.md 片段已保存: ${path.basename(mdFilepath)}`);
    console.log(`📊 文档大小: ${(fs.statSync(filepath).size / 1024).toFixed(2)} KB`);
  }

  generateClaadeMdFormat() {
    const wikidotPageFields = this.output.fields.WikidotPage;
    if (!wikidotPageFields) return '# WikidotPage 字段未找到';

    let content = `# WikidotPage 字段文档（自动生成）\n\n`;
    content += `生成时间: ${new Date().toISOString()}\n`;
    content += `总字段数: ${wikidotPageFields.total}\n\n`;

    // 按分类输出字段
    for (const [category, fields] of Object.entries(wikidotPageFields.categorized)) {
      content += `## ${category}\n\n`;
      
      for (const field of fields) {
        const deprecated = field.isDeprecated ? ' (已弃用)' : '';
        content += `- \`${field.name}: ${field.type}\`${deprecated}`;
        
        if (field.description) {
          content += ` - ${field.description}`;
        }
        content += '\n';
      }
      content += '\n';
    }

    // 未分类字段
    if (wikidotPageFields.uncategorized.length > 0) {
      content += `## 未分类字段\n\n`;
      for (const field of wikidotPageFields.uncategorized) {
        content += `- \`${field.name}: ${field.type}\``;
        if (field.description) {
          content += ` - ${field.description}`;
        }
        content += '\n';
      }
    }

    // 验证结果
    if (this.output.validatedFields.basic) {
      content += `\n## 字段验证结果\n\n`;
      content += `基础字段验证: ${this.output.validatedFields.basic.success ? '✅ 通过' : '❌ 失败'}\n`;
      
      if (this.output.validatedFields.complex) {
        content += `复杂字段验证: ${this.output.validatedFields.complex.success ? '✅ 通过' : '❌ 失败'}\n`;
      }
    }

    return content;
  }
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
  const explorer = new GraphQLDocExplorer();
  await explorer.explore();
}