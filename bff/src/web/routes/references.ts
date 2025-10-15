import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';

export function referencesRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  router.get('/graph', async (req, res, next) => {
    try {
      const { label } = req.query as { label?: string };
      let row: any | undefined;

      if (label) {
        const result = await pool.query(
          'SELECT label, description, "generatedAt", stats FROM "PageReferenceGraphSnapshot" WHERE label = $1 LIMIT 1',
          [label]
        );
        row = result.rows[0];
      } else {
        const result = await pool.query(
          'SELECT label, description, "generatedAt", stats FROM "PageReferenceGraphSnapshot" ORDER BY "generatedAt" DESC LIMIT 1'
        );
        row = result.rows[0];
      }

      if (!row) {
        return res.status(404).json({ error: 'snapshot_not_found' });
      }

      let payload = row.stats;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (error) {
          return res.status(500).json({ error: 'invalid_snapshot_payload' });
        }
      }

      res.json({
        label: row.label,
        description: row.description,
        generatedAt: row.generatedAt,
        data: payload
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

