import { gachaRouter } from './runtime.js';

export {
  loadDrawPoolSnapshot,
  executeDrawForUser,
  fetchActivePools,
  fetchActiveBoosts
} from './runtime.js';

export function drawRouter() {
  return gachaRouter();
}
