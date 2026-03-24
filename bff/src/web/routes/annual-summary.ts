import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// annual-summary 数据根目录（BFF 进程 cwd 下的 data/annual-summary）
const DATA_ROOT = path.resolve(process.cwd(), 'data', 'annual-summary');

// 年份白名单：仅允许纯数字
const YEAR_RE = /^\d{4}$/;
// userId 白名单：仅允许纯数字（wikidot userId）
const USER_ID_RE = /^\d+$/;

const CACHE_HEADER = 'public, max-age=86400, stale-while-revalidate=604800';

export function annualSummaryRouter() {
  const router = Router();

  // GET /:year/site.json
  router.get('/:year/site.json', async (req, res) => {
    const { year } = req.params;
    if (!YEAR_RE.test(year)) return res.status(400).json({ error: 'invalid_year' });

    const filePath = path.join(DATA_ROOT, year, 'site.json');
    try {
      const data = await readFile(filePath, 'utf-8');
      res.set('Cache-Control', CACHE_HEADER);
      res.set('Content-Type', 'application/json');
      res.send(data);
    } catch {
      res.status(404).json({ error: 'not_found' });
    }
  });

  // GET /:year/meta.json
  router.get('/:year/meta.json', async (req, res) => {
    const { year } = req.params;
    if (!YEAR_RE.test(year)) return res.status(400).json({ error: 'invalid_year' });

    const filePath = path.join(DATA_ROOT, year, 'meta.json');
    try {
      const data = await readFile(filePath, 'utf-8');
      res.set('Cache-Control', CACHE_HEADER);
      res.set('Content-Type', 'application/json');
      res.send(data);
    } catch {
      res.status(404).json({ error: 'not_found' });
    }
  });

  // GET /:year/users/index.json
  router.get('/:year/users/index.json', async (req, res) => {
    const { year } = req.params;
    if (!YEAR_RE.test(year)) return res.status(400).json({ error: 'invalid_year' });

    const filePath = path.join(DATA_ROOT, year, 'users', 'index.json');
    try {
      const data = await readFile(filePath, 'utf-8');
      res.set('Cache-Control', CACHE_HEADER);
      res.set('Content-Type', 'application/json');
      res.send(data);
    } catch {
      res.status(404).json({ error: 'not_found' });
    }
  });

  // GET /:year/users/:userId.json
  router.get('/:year/users/:userId.json', async (req, res) => {
    const { year, userId } = req.params;
    if (!YEAR_RE.test(year)) return res.status(400).json({ error: 'invalid_year' });
    if (!USER_ID_RE.test(userId)) return res.status(400).json({ error: 'invalid_user_id' });

    const filePath = path.join(DATA_ROOT, year, 'users', `${userId}.json`);
    try {
      const data = await readFile(filePath, 'utf-8');
      res.set('Cache-Control', CACHE_HEADER);
      res.set('Content-Type', 'application/json');
      res.send(data);
    } catch {
      res.status(404).json({ error: 'not_found' });
    }
  });

  return router;
}
