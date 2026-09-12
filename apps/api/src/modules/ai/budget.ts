import type { PrismaClient } from '@prisma/client';
import { Decimal, dec } from '@zusu/shared';
import { costOf, estimateTokens } from './pricing.js';

/**
 * Spend and rate controls (§55).
 *
 * The failure this exists to prevent is a loop that calls a model a thousand
 * times overnight. Three limits, all enforced before a call rather than
 * reported after it:
 *
 *   1. **A daily budget in dollars.** Checked against what has already been
 *      spent today plus an upper estimate of this call, so the budget cannot
 *      be crossed by the call that discovers it.
 *
 *   2. **A calls-per-hour ceiling**, which is what actually stops a runaway
 *      loop: a cheap model can make a thousand calls well inside a modest
 *      dollar budget.
 *
 *   3. **A per-call output cap**, so one call cannot spend the day's budget by
 *      generating for a very long time.
 *
 * Spend is read from `ai_analyses`, the same rows the UI shows, so the number
 * the governor enforces and the number a person sees cannot drift apart.
 */

export interface BudgetLimits {
  dailyUsd: string;
  callsPerHour: number;
  maxOutputTokensPerCall: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  // Deliberately small. A person raises it knowingly; nothing raises it on its
  // own, and there is no "unlimited" value.
  dailyUsd: '5',
  callsPerHour: 60,
  maxOutputTokensPerCall: 2_000,
};

export interface BudgetDecision {
  allowed: boolean;
  reason: string | null;
  spentTodayUsd: string;
  callsLastHour: number;
  /** The upper estimate this decision was made against. */
  estimatedCostUsd: string;
  limits: BudgetLimits;
}

export class BudgetGovernor {
  constructor(
    private readonly db: PrismaClient,
    private readonly limits: BudgetLimits = DEFAULT_BUDGET,
  ) {}

  /** What has been spent today, from the stored analyses. */
  async spentToday(at: Date = new Date()): Promise<Decimal> {
    const since = startOfUtcDay(at);
    const result = await this.db.aiAnalysis.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { costUsd: true },
    });
    return dec(result._sum.costUsd?.toString() ?? '0');
  }

  async callsLastHour(at: Date = new Date()): Promise<number> {
    return this.db.aiAnalysis.count({
      where: { createdAt: { gte: new Date(at.getTime() - 3_600_000) } },
    });
  }

  /**
   * Decides whether one call may be made.
   *
   * The estimate rounds against the caller: the whole prompt is counted as
   * input and the output cap is assumed to be reached, so a call that is
   * allowed cannot cross the budget by being longer than expected.
   */
  async check(input: {
    model: string;
    prompt: string;
    maxOutputTokens: number;
    at?: Date;
  }): Promise<BudgetDecision> {
    const at = input.at ?? new Date();
    const [spent, calls] = await Promise.all([this.spentToday(at), this.callsLastHour(at)]);

    const estimate = costOf(input.model, {
      inputTokens: estimateTokens(input.prompt),
      outputTokens: Math.min(input.maxOutputTokens, this.limits.maxOutputTokensPerCall),
    });

    const decide = (reason: string | null): BudgetDecision => ({
      allowed: reason === null,
      reason,
      spentTodayUsd: spent.toString(),
      callsLastHour: calls,
      estimatedCostUsd: estimate.toString(),
      limits: this.limits,
    });

    if (input.maxOutputTokens > this.limits.maxOutputTokensPerCall) {
      return decide(
        `A single call may not ask for more than ${String(this.limits.maxOutputTokensPerCall)} ` +
          'output tokens.',
      );
    }

    if (calls >= this.limits.callsPerHour) {
      // The limit that actually stops a runaway loop: a cheap model can make a
      // thousand calls well inside a modest dollar budget.
      return decide(
        `${String(calls)} analysis calls have been made in the last hour, which is the ` +
          'configured ceiling.',
      );
    }

    if (spent.plus(estimate).greaterThan(dec(this.limits.dailyUsd))) {
      return decide(
        `${spent.toFixed(4)} has been spent today and this call is estimated at ` +
          `${estimate.toFixed(4)}, which would cross the ${this.limits.dailyUsd} daily budget.`,
      );
    }

    return decide(null);
  }

  get configured(): BudgetLimits {
    return this.limits;
  }
}

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
