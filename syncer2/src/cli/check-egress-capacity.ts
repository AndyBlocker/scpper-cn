import { ADAPTIVE_EGRESS_POLICY } from '../http/adaptiveEgress.js';
import { assertEgressBudgetCapacity } from '../http/egressCapacity.js';

const check = assertEgressBudgetCapacity(ADAPTIVE_EGRESS_POLICY.rollingBudgetRequests);
process.stdout.write(`${JSON.stringify({ ok: true, ...check }, null, 2)}\n`);
