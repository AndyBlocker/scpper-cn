import { Router } from 'express';
import type { Pool } from 'pg';
import {
  CollectionOwnerPinConflictError,
  pinCollectionOwnerBeforeIdentityTransition
} from '../utils/collectionOwner.js';

const ACCOUNT_ID_MAX_LENGTH = 128;

export function internalCollectionOwnerRouter(pool: Pool) {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/pin', async (req, res, next) => {
    try {
      const accountId = String(req.body?.accountId || '').trim();
      const wikidotId = Number(req.body?.wikidotId);
      if (
        !accountId
        || accountId.length > ACCOUNT_ID_MAX_LENGTH
        || !Number.isInteger(wikidotId)
        || wikidotId <= 0
      ) {
        return res.status(400).json({ error: 'invalid_collection_owner_pin' });
      }

      const pinned = await pinCollectionOwnerBeforeIdentityTransition(
        pool,
        accountId,
        wikidotId
      );
      return res.json({ ok: true, pinned });
    } catch (error) {
      if (error instanceof CollectionOwnerPinConflictError) {
        return res.status(409).json({ error: error.code });
      }
      next(error);
    }
  });

  return router;
}
