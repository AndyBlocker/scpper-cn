/** 一次性/可重跑的 v1 ImageAsset 元数据与 URL→SHA 别名导入。 */

import { Command, InvalidArgumentError } from 'commander';

import { loadConfig } from '../config.js';
import {
  runV1ImageAssetImport,
  SHARED_IMAGE_ASSET_ROOT,
} from '../image/v1Import.js';
import { emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`必须是正整数，收到 ${value}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const command = new Command()
    .name('image-asset-import')
    .description('只读 v1，校验共享文件后幂等导入 ImageAsset 与唯一 SHA 引用')
    .option('--asset-root <path>', '共享内容寻址目录', SHARED_IMAGE_ASSET_ROOT)
    .option('--verify-concurrency <n>', '并行 SHA 校验数', positiveInt, 4)
    .option('--external-interval-ms <n>', '估时用外站相邻请求间隔', positiveInt, 1_000)
    .option('--wikidot-interval-ms <n>', '估时用 wikidot 相邻请求间隔', positiveInt, 7_200)
    .parse(process.argv);
  const cli = command.opts<{
    assetRoot: string;
    verifyConcurrency: number;
    externalIntervalMs: number;
    wikidotIntervalMs: number;
  }>();
  const config = loadConfig();
  if (config.v1DatabaseUrl === null) {
    throw new Error(
      '缺少 SYNCER2_V1_DATABASE_URL；必须保留 options=-c default_transaction_read_only=on',
    );
  }
  const startedAt = Date.now();
  const report = await runV1ImageAssetImport({
    v1DatabaseUrl: config.v1DatabaseUrl,
    v2DatabaseUrl: config.databaseUrl,
    assetRoot: cli.assetRoot,
    verifyConcurrency: cli.verifyConcurrency,
    externalIntervalMs: cli.externalIntervalMs,
    wikidotIntervalMs: cli.wikidotIntervalMs,
    onProgress: (completed, total) => {
      process.stderr.write(`[image-asset-import] SHA 校验 ${completed}/${total}\n`);
    },
  });
  emitSummary({
    ok: report.metadata.unimportableRows === 0,
    status: report.metadata.failedRows === 0 ? 'ok' : 'partial',
    durationMs: Date.now() - startedAt,
    assetRoot: cli.assetRoot,
    ...report,
  });
  process.exitCode = report.metadata.unimportableRows === 0 ? 0 : 1;
}

await main().catch((error) => {
  emitSummary({ ok: false, status: 'failed', error: String(error) });
  process.exitCode = 1;
});
