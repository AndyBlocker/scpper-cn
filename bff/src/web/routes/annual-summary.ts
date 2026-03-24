import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// annual-summary 数据根目录：兼容从 bff/ 或 repo root 启动
const DATA_ROOT = (() => {
  const candidates = [
    process.env.ANNUAL_SUMMARY_DATA_DIR,
    path.resolve(process.cwd(), 'data/annual-summary'),
    path.resolve(process.cwd(), 'bff/data/annual-summary')
  ].filter((v): v is string => Boolean(v));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] || path.resolve(process.cwd(), 'data/annual-summary');
})();

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
