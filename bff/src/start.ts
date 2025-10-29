import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { buildRouter } from './web/router.js';
import { createProxyMiddleware } from 'http-proxy-middleware';

export async function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp());

  // Proxy avatar to avatar-agent early to avoid interference
  // Important: include '/avatar' in target so that Express mount path truncation is compensated.
  app.use('/avatar', createProxyMiddleware({ target: 'http://127.0.0.1:3200/avatar', changeOrigin: false, xfwd: true }));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.PG_DATABASE_URL });
  let redis: any = null;
  const enableCache = String(process.env.ENABLE_CACHE || 'false') === 'true';
  if (enableCache) {
    const redisUrl = process.env.REDIS_URL;
    const redisHost = process.env.REDIS_HOST || '127.0.0.1';
    const redisPort = Number(process.env.REDIS_PORT || 6379);
    const redisPassword = process.env.REDIS_PASSWORD || process.env.REDIS_AUTH;
    const redisDbRaw = process.env.REDIS_DB;
    const redisDb = redisDbRaw !== undefined ? Number(redisDbRaw) : undefined;
    const redisOptions = redisUrl
      ? { url: redisUrl }
      : {
          socket: {
            host: redisHost,
            port: Number.isFinite(redisPort) ? redisPort : 6379
          },
          password: redisPassword ? String(redisPassword) : undefined,
          database: redisDb !== undefined && Number.isFinite(redisDb) ? redisDb : undefined
        };
    redis = createClient(redisOptions as any);
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
