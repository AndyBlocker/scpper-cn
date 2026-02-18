import { gachaRouter } from './runtime.js';

export {
  loadMissionProgressSnapshots,
  loadUserGachaStats
} from './runtime.js';

export function missionsRouter() {
  return gachaRouter();
}
