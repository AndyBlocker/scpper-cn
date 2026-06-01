import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import {
  triggerTradeExpirySweep,
  triggerBuyRequestExpirySweep,
  triggerMarketSettleSweep,
  TRADE_EXPIRY_SWEEP_INTERVAL_MS,
  BUY_REQUEST_EXPIRY_SWEEP_INTERVAL_MS,
  MARKET_SETTLE_SWEEP_INTERVAL_MS
} from './routes/gacha/index.js';

async function main() {
  const app = createApp();
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[user-backend] listening on http://localhost:${config.port}`);
  });

  // Background expiry sweeps — each on its own interval to avoid bunching.
  const tradeTimer = setInterval(triggerTradeExpirySweep, TRADE_EXPIRY_SWEEP_INTERVAL_MS);
  const buyReqTimer = setInterval(triggerBuyRequestExpirySweep, BUY_REQUEST_EXPIRY_SWEEP_INTERVAL_MS);
  const marketTimer = setInterval(triggerMarketSettleSweep, MARKET_SETTLE_SWEEP_INTERVAL_MS);
  tradeTimer.unref();
  buyReqTimer.unref();
  marketTimer.unref();

  let isShuttingDown = false;
  const shutdown = (signal: string, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down...`);
    clearInterval(tradeTimer);
    clearInterval(buyReqTimer);
    clearInterval(marketTimer);

    const forceTimer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('Graceful shutdown timed out after 10s, forcing exit');
      process.exit(exitCode || 1);
    }, 10_000);
    forceTimer.unref();

    server.close((err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error('server.close error:', err);
      }
      prisma.$disconnect()
        .catch((disconnectErr: unknown) => {
          // eslint-disable-next-line no-console
          console.error('prisma.$disconnect error:', disconnectErr);
        })
        .finally(() => {
          clearTimeout(forceTimer);
          process.exit(err ? 1 : exitCode);
        });
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 全局兜底：未处理的 Promise rejection 仅记录(不退出,避免单个失败拖垮服务)；
  // 未捕获异常视为进程已处于不可知状态，记录后优雅关闭(由 PM2 拉起新进程)。
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[user-backend] Unhandled promise rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[user-backend] Uncaught exception, shutting down:', err);
    void shutdown('uncaughtException', 1);
  });
}

main().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error('[user-backend] failed to start', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
