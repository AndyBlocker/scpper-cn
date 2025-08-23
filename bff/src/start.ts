import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { buildRouter } from './web/router.js';

export async function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp());

  const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.PG_DATABASE_URL });
  let redis: any = null;
  const enableCache = String(process.env.ENABLE_CACHE || 'false') === 'true';
  if (enableCache) {
    redis = createClient({ url: process.env.REDIS_URL || '' });
    redis.on('error', (e: unknown) => console.error(e));
    await redis.connect();
  }

  app.use('/', buildRouter(pool, redis));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Basic error handler (JSON) for easier debugging
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => {
    // eslint-disable-next-line no-console
    console.error(err);
    const message = err?.message || 'Internal Server Error';
    res.status(500).json({ error: message });
  });

  return app;
}


