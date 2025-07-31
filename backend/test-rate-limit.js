#!/usr/bin/env node
// test-rate-limit.js
/**
 * Simple script to trigger rate limit and display 429 error headers
 */

// 最简单的GraphQL查询，用于快速触发rate limit
const SIMPLE_QUERY = `
  query TestRateLimit {
    pages(first: 100) {
      edges {
        node {
          url
        }
      }
    }
  }
`;

// 使用原生fetch发送GraphQL请求以获取完整headers
async function sendGraphQLRequest(query) {
  const response = await fetch('https://apiv2.crom.avn.sh/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ query })
  });
  
  // 提取所有headers
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  
  const data = await response.json();
  
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    data,
    response
  };
}

async function triggerRateLimit() {
  console.log('🚀 开始发送请求触发Rate Limit...');
  console.log('📊 每个请求的复杂度: ~100 points (first: 100)');
  console.log('⏱️  发送间隔: 100ms');
  console.log('');
  
  let requestCount = 0;
  let startTime = Date.now();
  
  while (true) {
    try {
      requestCount++;
      const currentTime = Date.now();
      const elapsed = (currentTime - startTime) / 1000;
      
      console.log(`📤 请求 #${requestCount} (已运行 ${elapsed.toFixed(1)}s)`);
      
      const result = await sendGraphQLRequest(SIMPLE_QUERY);
      
      // 检查状态码
      if (result.status === 429) {
        // 触发了rate limit
        console.log('\n🚨 触发Rate Limit！');
        console.log('==========================================');
        console.log(`📊 总请求数: ${requestCount}`);
        console.log(`⏱️  用时: ${elapsed.toFixed(1)}秒`);
        console.log(`📈 平均请求速率: ${(requestCount / elapsed).toFixed(1)} req/s`);
        console.log('');
        
        // 显示完整的响应信息
        console.log('🔍 完整响应信息:');
        console.log('==========================================');
        console.log(`状态码: ${result.status} ${result.statusText}`);
        console.log('');
        
        // 显示所有Headers
        console.log('📋 所有Response Headers:');
        console.log('==========================================');
        if (Object.keys(result.headers).length > 0) {
          Object.entries(result.headers).forEach(([key, value]) => {
            console.log(`${key}: ${value}`);
          });
        } else {
          console.log('❌ 没有找到任何headers');
        }
        console.log('');
        
        // 重点显示Rate Limit相关Headers
        console.log('⚡ Rate Limit 相关Headers:');
        console.log('==========================================');
        const rateLimitHeaders = [
          'retry-after',
          'x-ratelimit-limit',
          'x-ratelimit-remaining', 
          'x-ratelimit-reset',
          'x-ratelimit-reset-after',
          'ratelimit-limit',
          'ratelimit-remaining',
          'ratelimit-reset',
          'rate-limit-limit',
          'rate-limit-remaining',
          'rate-limit-reset',
          'x-rate-limit-limit',
          'x-rate-limit-remaining',
          'x-rate-limit-reset'
        ];
        
        let foundRateLimitHeaders = false;
        rateLimitHeaders.forEach(headerName => {
          const value = result.headers[headerName] || result.headers[headerName.toLowerCase()];
          if (value !== undefined) {
            console.log(`${headerName}: ${value}`);
            foundRateLimitHeaders = true;
          }
        });
        
        if (!foundRateLimitHeaders) {
          console.log('❌ 未找到标准的rate limit headers');
        }
        
        // 显示响应体内容
        console.log('');
        console.log('📄 响应体内容:');
        console.log('==========================================');
        console.log(JSON.stringify(result.data, null, 2));
        
        break;
        
      } else if (result.status !== 200) {
        // 其他错误状态码
        console.log(`❌ 请求 #${requestCount} 失败 (状态码: ${result.status})`);
        console.log(`   状态文本: ${result.statusText}`);
        console.log(`   响应内容:`, JSON.stringify(result.data, null, 2));
        
        // 如果连续失败太多次，停止
        if (requestCount > 10) {
          console.log('\n⚠️  连续失败次数过多，停止测试');
          break;
        }
        
      } else if (result.data.errors) {
        // GraphQL错误
        console.log(`⚠️  请求 #${requestCount} 有GraphQL错误:`);
        result.data.errors.forEach((error, index) => {
          console.log(`   错误 ${index + 1}: ${error.message}`);
        });
        
      } else {
        // 成功的请求
        console.log(`✅ 请求 #${requestCount} 成功 (返回 ${result.data.data?.pages?.edges?.length || 0} 页面)`);
      }
      
      // 短暂延迟避免过于频繁
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (error) {
      // 网络错误或其他异常
      console.log(`❌ 请求 #${requestCount} 网络错误:`);
      console.log(`   错误类型: ${error.constructor.name}`);
      console.log(`   错误消息: ${error.message}`);
      
      // 如果连续失败太多次，停止
      if (requestCount > 10) {
        console.log('\n⚠️  连续失败次数过多，停止测试');
        break;
      }
      
      // 稍等后继续
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  console.log('Rate Limit 测试脚本');
  console.log('===================');
  console.log('目标: 触发CROM API的Rate Limit并查看429错误的完整headers');
  console.log('');
  
  try {
    await triggerRateLimit();
  } catch (error) {
    console.error('脚本执行出错:', error);
  }
  
  console.log('\n✅ 测试完成');
}

// 运行脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}