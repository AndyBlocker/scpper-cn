import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';

async function main() {
  const app = createApp();
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[user-backend] listening on http://localhost:${config.port}`);
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down...`);
    server.close(async () => {
      await prisma.$disconnect();
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
