import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import {
  triggerTradeExpirySweep,
  triggerBuyRequestExpirySweep,
  triggerMarketSettleSweep
} from './routes/gacha/index.js';

const EXPIRY_SWEEP_INTERVAL_MS = 60_000; // 60 seconds

async function main() {
  const app = createApp();
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[user-backend] listening on http://localhost:${config.port}`);
  });

  // Background expiry sweeps — ensure expired trades/buy-requests are cleaned
  // up even when no user traffic is flowing.
  const sweepTimer = setInterval(() => {
    triggerTradeExpirySweep();
    triggerBuyRequestExpirySweep();
    triggerMarketSettleSweep();
  }, EXPIRY_SWEEP_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down...`);
    clearInterval(sweepTimer);

    const forceTimer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('Graceful shutdown timed out after 10s, forcing exit');
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    server.close(async () => {
      await prisma.$disconnect();
      clearTimeout(forceTimer);
      process.exit(0);
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
