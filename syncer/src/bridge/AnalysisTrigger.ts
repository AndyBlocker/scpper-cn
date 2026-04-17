/**
 * AnalysisTrigger — 在 bridge 写入主库后触发 v1 分析管道
 *
 * 使用子进程调用 backend 的 analyze:incremental CLI，
 * 这样无需导入 backend 的模块，保持 syncer 的独立性。
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKEND_DIR = path.resolve(__dirname, '../../../backend');

/**
 * 触发 v1 分析管道（增量模式，水位线机制自动跳过无变更任务）
 * 返回是否成功
 */
export async function triggerAnalysis(options?: {
  timeout?: number;
}): Promise<boolean> {
  const timeout = options?.timeout ?? 15 * 60 * 1000; // 15 分钟

  console.log(`[analysis] Triggering incremental analysis...`);
  const t0 = Date.now();

  return new Promise<boolean>((resolve) => {
    const child = spawn(
      'node',
      [
        '--import', 'tsx/esm',
        'src/cli/index.ts',
        'analyze',
      ],
      {
        cwd: BACKEND_DIR,
        env: { ...process.env, NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      // 透传关键日志
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && (trimmed.includes('📊') || trimmed.includes('✅') || trimmed.includes('❌') || trimmed.includes('category_index_tick'))) {
          console.log(`[analysis] ${trimmed}`);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      console.warn(`[analysis] Timeout after ${timeout / 1000}s, killing...`);
      child.kill('SIGTERM');
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (code === 0) {
        console.log(`[analysis] Completed in ${elapsed}s`);
        resolve(true);
      } else {
        console.error(`[analysis] Failed (exit ${code}) in ${elapsed}s`);
        if (stderr) {
          // 只打印最后几行错误
          const lines = stderr.trim().split('\n').slice(-5);
          for (const line of lines) console.error(`[analysis] ${line}`);
        }
        resolve(false);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[analysis] Spawn error:`, err.message);
      resolve(false);
    });
  });
}
