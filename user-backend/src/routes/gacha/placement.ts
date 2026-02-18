import { gachaRouter } from './runtime.js';

export {
  resolvePlacementComboBonuses,
  computePlacementMetrics
} from './runtime.js';

export function placementRouter() {
  return gachaRouter();
}
