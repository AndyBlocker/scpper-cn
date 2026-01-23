import { Router } from 'express';
import { getReadPoolSync } from '../utils/dbPool.js';

export function internalRouter() {
  const router = Router();
  const readPool = getReadPoolSync();

  // GET /internal/wikidot-user?username=...
  router.get('/wikidot-user', async (req, res, next) => {
    try {
      const raw = (req.query as Record<string, string | undefined>).username;
      const username = typeof raw === 'string' ? raw.trim() : '';
      if (!username) return res.status(400).json({ error: 'username_required' });

      const { rows } = await readPool.query<{
        wikidotId: number | null;
        displayName: string | null;
        username: string | null;
      }>(
        `SELECT "wikidotId", "displayName", username
           FROM "User"
          WHERE lower(username) = lower($1)
          LIMIT 1`,
        [username]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'not_found' });
      }

      const row = rows[0];
      const wikidotId = Number(row.wikidotId);
      if (!Number.isFinite(wikidotId) || wikidotId <= 0) {
        return res.status(404).json({ error: 'not_found' });
      }

      return res.json({
        ok: true,
        user: {
          wikidotId,
          displayName: row.displayName ?? null,
          username: row.username ?? null
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
