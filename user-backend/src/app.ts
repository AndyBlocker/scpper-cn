import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { gachaRouter, gachaAdminRouter } from './routes/gacha.js';
import { eventsRouter } from './routes/events.js';
import { ftmlProjectsRouter } from './routes/ftml-projects.js';
import { wikidotBindingRouter, wikidotBindingInternalRouter } from './routes/wikidotBinding.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp());

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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  });

  return app;
}
