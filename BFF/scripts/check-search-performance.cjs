// 检查搜索性能的脚本
const { exec } = require('child_process');

const tests = [
  {
    name: '基础搜索',
    url: 'http://localhost:4396/search?q=SCP&limit=3',
  },
  {
    name: '标题高级搜索',  
    url: 'http://localhost:4396/search/advanced?title=SCP&limit=3',
  },
  {
    name: '标签过滤搜索',
    url: 'http://localhost:4396/search/advanced?title=SCP&includeTags=safe&limit=3',
  },
  {
    name: '内容搜索 (危险)',
    url: 'http://localhost:4396/search/advanced?content=基金会&limit=3',
  }
];

async function runTest(test) {
  return new Promise((resolve) => {
    const start = Date.now();
    exec(`curl -s "${test.url}" --max-time 5`, (error, stdout, stderr) => {
      const duration = Date.now() - start;
      
      if (error && error.code === 28) {
        resolve({ ...test, duration: '>5000ms', status: 'TIMEOUT' });
      } else if (error) {
        resolve({ ...test, duration: `${duration}ms`, status: 'ERROR', error: error.message });
      } else {
        try {
          const result = JSON.parse(stdout);
          const count = result.success ? result.data.results?.length || 0 : 0;
          resolve({ 
            ...test, 
            duration: `${duration}ms`, 
            status: 'OK',
            results: count,
            total: result.data?.total || 0
          });
        } catch (e) {
          resolve({ ...test, duration: `${duration}ms`, status: 'PARSE_ERROR' });
        }
      }
    });
  });
}

async function main() {
  console.log('🔍 搜索性能测试\n');
  
  for (const test of tests) {
    console.log(`测试: ${test.name}`);
    const result = await runTest(test);
    
    console.log(`  时间: ${result.duration}`);
    console.log(`  状态: ${result.status}`);
    if (result.results !== undefined) {
      console.log(`  结果: ${result.results}/${result.total}`);
    }
    if (result.error) {
      console.log(`  错误: ${result.error}`);
    }
    console.log();
  }
}

main().catch(console.error);