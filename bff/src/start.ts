import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import { createClient } from 'redis';
import { buildRouter } from './web/router.js';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { initPools } from './web/utils/dbPool.js';

export async function createServer() {
  const app = express();
  app.disable('x-powered-by');
  // Trust the first proxy (Nginx) so req.ip maps to real client IP.
  app.set('trust proxy', 1);
  app.use(helmet());
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  app.use(cors({
    origin: allowedOrigins.length > 0
      ? (origin, cb) => {
          if (!origin || allowedOrigins.includes(origin)) cb(null, true);
          else cb(new Error('Not allowed by CORS'));
        }
      : false,
    credentials: true
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({
    autoLogging: {
      ignore: (req) => req.url === '/healthz'
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-internal-key"]',
        'res.headers["set-cookie"]'
      ],
      censor: '[REDACTED]'
    }
  }));

  // Global rate limit: 300 requests per minute per IP.
  // The frontend fires ~25-30 requests per page load (alerts, relations,
  // vote-status, stats, etc.), so 120 was too tight for normal browsing
  // across 3-4 navigations per minute.
  // Skip healthz (monitoring), /internal (authenticated server-to-server),
  // and /avatar (proxied to avatar-agent which has its own limits).
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests' },
    skip: (req) => {
      const p = req.path;
      return p === '/healthz' || p.startsWith('/internal') || p.startsWith('/avatar');
    }
  });
  app.use(globalLimiter);

  // Proxy avatar to avatar-agent early to avoid interference
  // Important: include '/avatar' in target so that Express mount path truncation is compensated.
  const avatarAgentBase = (process.env.AVATAR_AGENT_BASE_URL || 'http://127.0.0.1:3200').replace(/\/$/, '');
  app.use('/avatar', createProxyMiddleware({
    target: `${avatarAgentBase}/avatar`,
    changeOrigin: false,
    xfwd: true
  }));

  const allowDblessTestMode = process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL;
  if (allowDblessTestMode) {
    // Jest unit tests may exercise non-DB routes; provide a dummy DSN so pool bootstrap can proceed.
    process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/test';
  }
  // 初始化双连接池（主库 + 从库）
  const pool = initPools().primary;
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

  // Global error handler – never leak internal details in production
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => {
    // eslint-disable-next-line no-console
    console.error(err);
    const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    const message = isDev ? (err?.message || 'Internal Server Error') : 'Internal Server Error';
    res.status(500).json({ error: message });
  });

  return app;
}
