import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';

/**
 * 年度报告数据路由。
 * 从 bff/data/annual-summary/ 读取预生成的 JSON 文件并返回。
 * 数据文件不会变化，因此设置较长的缓存时间。
 */

// 数据根目录：相对于 bff/ 项目根目录
const DATA_ROOT = path.resolve(
  import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/annual-summary'
);

async function serveJsonFile(subPath: string, res: Response) {
  // 安全检查：不能包含 .. 或反斜杠，防止目录穿越
  if (/\.\./.test(subPath) || /\\/.test(subPath)) {
    return res.status(400).json({ error: 'invalid_path' });
  }

  const filePath = path.join(DATA_ROOT, subPath);

  // 确保解析后的路径仍在 DATA_ROOT 内（双重防护）
  if (!filePath.startsWith(DATA_ROOT + path.sep)) {
    return res.status(400).json({ error: 'invalid_path' });
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(content);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'not_found' });
    }
    console.error(`[annual-summary] Failed to read ${filePath}:`, err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
}

export function annualSummaryRouter() {
  const router = Router();

  // year param 必须是 4 位数字
  router.param('year', (req, res, next, value) => {
    if (!/^\d{4}$/.test(value)) {
      return res.status(400).json({ error: 'invalid_year' });
    }
    return next();
  });

  // GET /annual-summary/:year/site.json
  router.get('/:year/site.json', (req: Request, res: Response) => {
    return serveJsonFile(`${req.params.year}/site.json`, res);
  });

  // GET /annual-summary/:year/meta.json
  router.get('/:year/meta.json', (req: Request, res: Response) => {
    return serveJsonFile(`${req.params.year}/meta.json`, res);
  });

  // GET /annual-summary/:year/users/index.json
  router.get('/:year/users/index.json', (req: Request, res: Response) => {
    return serveJsonFile(`${req.params.year}/users/index.json`, res);
  });

  // GET /annual-summary/:year/users/:fileId.json
  // fileId 是用户的 wikidot ID（纯数字）
  router.get('/:year/users/:fileId.json', (req: Request, res: Response) => {
    const fileId = req.params['fileId'];
    if (!fileId || !/^\d+$/.test(fileId)) {
      return res.status(400).json({ error: 'invalid_user_id' });
    }
    return serveJsonFile(`${req.params.year}/users/${fileId}.json`, res);
  });

  return router;
}
