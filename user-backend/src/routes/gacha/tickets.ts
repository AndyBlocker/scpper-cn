import { gachaRouter } from './runtime.js';

export {
  computeTicketBalance,
  consumeTicketBalance
} from './runtime.js';

export function ticketsRouter() {
  return gachaRouter();
}
