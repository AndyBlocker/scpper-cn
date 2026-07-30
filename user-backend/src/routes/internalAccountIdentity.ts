import { Router } from 'express';
import { prisma } from '../db.js';
import { verifyInternalKey } from '../utils/internalAuth.js';

const ACCOUNT_ID_MAX_LENGTH = 128;

/**
 * Read-through account identity for BFF authorization checks.
 *
 * This intentionally does not use the auth/session cache: collection claims
 * must reflect an unlink or takeover immediately, even when the account never
 * makes another private collection request.
 */
export function internalAccountIdentityRouter() {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.use((req, res, next) => {
    const auth = verifyInternalKey(req, 'BFF_INTERNAL_API_KEY');
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    next();
  });

  router.get('/:accountId', async (req, res) => {
    const accountId = String(req.params.accountId || '').trim();
    if (!accountId || accountId.length > ACCOUNT_ID_MAX_LENGTH) {
      return res.status(400).json({ error: 'invalid_account_id' });
    }

    try {
      const account = await prisma.userAccount.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          linkedWikidotId: true,
          status: true
        }
      });
      if (!account) {
        return res.status(404).json({ error: 'account_not_found' });
      }

      return res.json({
        ok: true,
        account: {
          id: account.id,
          linkedWikidotId: account.linkedWikidotId ?? null,
          status: account.status
        }
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[internal-account-identity] lookup failed:', error);
      return res.status(500).json({ error: 'lookup_failed' });
    }
  });

  return router;
}
