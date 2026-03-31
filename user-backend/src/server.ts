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

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down...`);
    clearInterval(tradeTimer);
    clearInterval(buyReqTimer);
    clearInterval(marketTimer);

    const forceTimer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('Graceful shutdown timed out after 10s, forcing exit');
      process.exit(1);
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
          process.exit(err ? 1 : 0);
        });
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error('[user-backend] failed to start', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
