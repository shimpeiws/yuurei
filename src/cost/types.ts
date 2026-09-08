export interface UsageRecord {
  runtimeId: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface CostEstimate {
  /** null = cannot be estimated, distinct from a real zero-cost result. */
  amount: number | null;
  currency: string | null;
}

/**
 * Boundary converting observed usage into cost. v0.3 ships only a no-op
 * implementation (see ./noop.ts); pricing/cost logic is deliberately out
 * of scope so trace data stays re-computable later (design doc §6.4).
 */
export interface CostModel {
  id(): string;
  estimate(input: UsageRecord): Promise<CostEstimate>;
}
