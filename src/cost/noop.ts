import type { CostEstimate, CostModel, UsageRecord } from './types.js';

/** v0.3's only CostModel implementation: always declines to estimate. */
export class NoopCostModel implements CostModel {
  id(): string {
    return 'noop';
  }

  async estimate(_input: UsageRecord): Promise<CostEstimate> {
    return { amount: null, currency: null };
  }
}
