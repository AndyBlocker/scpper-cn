import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireAdmin } from '../../middleware/requireAdmin.js';
import { ensureFeatureEnabled, resolveFeatureByPath, triggerTradeExpirySweep, triggerBuyRequestExpirySweep, triggerMarketSettleSweep } from './_helpers.js';
import { registerCoreRoutes } from './core.routes.js';
import { registerDrawRoutes } from './draw.routes.js';
import { registerAlbumRoutes } from './album.routes.js';
import { registerPlacementRoutes } from './placement.routes.js';
import { registerTicketsRoutes } from './tickets.routes.js';
import { registerMissionsRoutes } from './missions.routes.js';
import { registerMarketRoutes } from './market.routes.js';
import { registerTradeRoutes } from './trade.routes.js';
import { registerAdminRoutes } from './admin.routes.js';

export function gachaRouter() {
  const router = Router();

  router.use(requireAuth);
  router.use((req, res, next) => {
    const feature = resolveFeatureByPath(req.path ?? '');
    if (!feature || ensureFeatureEnabled(res, feature)) {
      next();
    }
  });

  registerCoreRoutes(router);
  registerDrawRoutes(router);
  registerAlbumRoutes(router);
  registerPlacementRoutes(router);
  registerTicketsRoutes(router);
  registerMissionsRoutes(router);
  registerMarketRoutes(router);
  registerTradeRoutes(router);

  return router;
}

export function gachaAdminRouter() {
  const router = Router();

  router.use(requireAdmin);

  registerAdminRoutes(router);

  return router;
}

export { triggerTradeExpirySweep, triggerBuyRequestExpirySweep, triggerMarketSettleSweep };
export {
  TRADE_EXPIRY_SWEEP_INTERVAL_MS,
  BUY_REQUEST_EXPIRY_SWEEP_INTERVAL_MS,
  MARKET_SETTLE_SWEEP_INTERVAL_MS
} from './_helpers.js';
