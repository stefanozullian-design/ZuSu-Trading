import { Decimal, dec } from '@zusu/shared';
import type { TokenUsage } from './types.js';

/**
 * What a call costs (§55).
 *
 * Prices are per million tokens and are stated here as data, with the date
 * they were taken, because a hard-coded price that silently goes stale
 * produces a spend report that is wrong in the reassuring direction. A model
 * this table does not know is *not* costed at zero — `costOf` refuses, and the
 * caller must add the price rather than run an uncosted call.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMillion: string;
  /** USD per million output tokens. */
  outputPerMillion: string;
  /** When this price was last checked, so staleness is visible. */
  asOf: string;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-haiku-4-5-20251001': {
    inputPerMillion: '1',
    outputPerMillion: '5',
    asOf: '2026-09-12',
  },
  'claude-sonnet-5': {
    inputPerMillion: '3',
    outputPerMillion: '15',
    asOf: '2026-09-12',
  },
  'claude-opus-5': {
    inputPerMillion: '15',
    outputPerMillion: '75',
    asOf: '2026-09-12',
  },
});

/** The cheap screening model, and the one that writes the analysis. */
export const SCREEN_MODEL = 'claude-haiku-4-5-20251001';
export const ANALYSIS_MODEL = 'claude-sonnet-5';

export class UnknownModelPriceError extends Error {
  constructor(model: string) {
    super(
      `No price is recorded for ${model}, so a call to it cannot be costed. ` +
        'Add it to MODEL_PRICES rather than running an uncosted call.',
    );
    this.name = 'UnknownModelPriceError';
  }
}

export function costOf(model: string, usage: TokenUsage): Decimal {
  const price = MODEL_PRICES[model];
  if (!price) throw new UnknownModelPriceError(model);

  const input = dec(price.inputPerMillion).times(usage.inputTokens).div(1_000_000);
  const output = dec(price.outputPerMillion).times(usage.outputTokens).div(1_000_000);
  return input.plus(output);
}

/**
 * A rough token count, for estimating a call before making it.
 *
 * Four characters per token is the usual approximation for English prose. It is
 * an estimate and named as one: the budget check that uses it rounds *up*, and
 * the real usage from the response is what gets recorded.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
