import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { gachaRouter, gachaAdminRouter } from './routes/gacha/index.js';
import { eventsRouter } from './routes/events.js';
import { ftmlProjectsRouter } from './routes/ftml-projects.js';
import { wikidotBindingRouter, wikidotBindingInternalRouter } from './routes/wikidotBinding.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // 压缩响应（按 Accept-Encoding 协商 br/gzip）。大 JSON（如重库存用户 /gacha/inventory 全量
  // 6.5MB）原先未压缩，跨 BFF/openresty 透传到客户端需数秒传输。compression 用 zlib 流在线程池
  // 压缩（不阻塞主事件循环），高重复 JSON 可压到 ~10-15%。BFF http-proxy 与 openresty 均透传上游
  // Content-Encoding。
  app.use(compression());
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
    // 精简请求/响应日志：只记 method/url/远端地址 + 状态码，不落盘完整 header。
    // 默认 serializer 会把每个请求的全部 header 写入，导致 out 日志数小时打满数十 MB。
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url, remoteAddress: req.remoteAddress }),
      res: (res) => ({ statusCode: res.statusCode })
    },
    // 防御性保留：即使将来 serializer 改回包含 header，也不落盘敏感字段。
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]'
      ],
      censor: '[REDACTED]'
    }
  }));

  app.use('/auth', authRouter());
  app.use('/admin', adminRouter());
  app.use('/gacha/admin', gachaAdminRouter());
  app.use('/gacha', gachaRouter());
  app.use('/events', eventsRouter());
  app.use('/ftml-projects', ftmlProjectsRouter());
  app.use('/wikidot-binding', wikidotBindingRouter());
  app.use('/internal/wikidot-binding', wikidotBindingInternalRouter());

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Global error handler – never leak internal details in production
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    const message = isDev && err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  });

  return app;
}
