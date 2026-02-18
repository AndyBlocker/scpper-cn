import { gachaRouter, triggerTradeExpirySweep } from './runtime.js';

export function tradeRouter() {
  return gachaRouter();
}

export function sweepExpiredTradeListings() {
  triggerTradeExpirySweep();
}
