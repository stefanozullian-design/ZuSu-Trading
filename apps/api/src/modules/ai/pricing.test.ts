import { dec } from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import { parseStructured } from './analysis.service.js';
import { MODEL_PRICES, UnknownModelPriceError, costOf, estimateTokens } from './pricing.js';
import { analysisResultSchema, screenResultSchema } from './types.js';

/**
 * Costing and output validation.
 *
 * Two refusals under test: a model with no recorded price is not costed at
 * zero, and a reply that does not match its schema is not repaired. Both are
 * cases where the convenient behaviour is the dangerous one.
 */

describe('costing', () => {
  it('prices a call from the tokens the provider reported', () => {
    const cost = costOf('claude-haiku-4-5-20251001', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    // A million of each at $1 and $5.
    expect(cost.toString()).toBe('6');
  });

  it('scales linearly and keeps the arithmetic exact', () => {
    const cost = costOf('claude-sonnet-5', { inputTokens: 1_234, outputTokens: 567 });

    // 1,234 × 3/1e6 + 567 × 15/1e6, computed as decimals rather than floats.
    const expected = dec('3').times(1_234).div(1_000_000).plus(dec('15').times(567).div(1_000_000));
    expect(cost.toString()).toBe(expected.toString());
  });

  it('refuses to cost a model it has no price for', () => {
    // A zero here would be a spend report that is wrong in the reassuring
    // direction.
    expect(() => costOf('some-future-model', { inputTokens: 10, outputTokens: 10 })).toThrow(
      UnknownModelPriceError,
    );
  });

  it('records when each price was last checked', () => {
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      expect(price.asOf, model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('estimates tokens on the high side of a short string', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    // Rounds up, so a budget check is never optimistic.
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('parsing a model reply', () => {
  const valid = {
    action: 'CONSIDER',
    confidence: 0.62,
    riskLevel: 'MEDIUM',
    rationale: 'RSI is oversold while price holds above the 50-period average.',
    invalidation: 'A close below the 50-period average.',
    missingContext: ['earnings date'],
    regime: 'RANGE_BOUND',
  };

  it('accepts a clean object', () => {
    const parsed = parseStructured(analysisResultSchema, JSON.stringify(valid));
    expect(parsed.ok).toBe(true);
  });

  it('accepts an object wrapped in a fenced block or prose', () => {
    const wrapped = `Here is my analysis:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nHope that helps.`;
    const parsed = parseStructured(analysisResultSchema, wrapped);

    // Tolerant about the wrapper, strict about the content.
    expect(parsed.ok).toBe(true);
  });

  it('rejects a confidence outside zero and one, rather than clamping it', () => {
    const parsed = parseStructured(
      analysisResultSchema,
      JSON.stringify({ ...valid, confidence: 1.4 }),
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('confidence');
  });

  it('rejects an action it does not recognise', () => {
    const parsed = parseStructured(
      analysisResultSchema,
      JSON.stringify({ ...valid, action: 'BUY_NOW' }),
    );

    // A model cannot invent an instruction by inventing an enum value.
    expect(parsed.ok).toBe(false);
  });

  it('rejects a reply missing its reasoning', () => {
    const { rationale: _rationale, ...withoutRationale } = valid;
    const parsed = parseStructured(analysisResultSchema, JSON.stringify(withoutRationale));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('rationale');
  });

  it('reports a reply with no JSON at all', () => {
    const parsed = parseStructured(analysisResultSchema, 'I would rather not answer that.');

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('no JSON object');
  });

  it('reports malformed JSON rather than repairing it', () => {
    const parsed = parseStructured(analysisResultSchema, '{"action":"CONSIDER",');

    // A repaired response is one nobody can audit.
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/did not parse|no JSON/);
  });

  it('defaults the optional fields rather than leaving them undefined', () => {
    const { missingContext: _missing, regime: _regime, ...minimal } = valid;
    const parsed = parseStructured(analysisResultSchema, JSON.stringify(minimal));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.missingContext).toEqual([]);
      expect(parsed.value.regime).toBeNull();
    }
  });
});

describe('the screen schema', () => {
  it('cannot express a recommendation', () => {
    const withAdvice = {
      shortlist: [{ symbol: 'AAPL', reason: 'oversold' }],
      setAside: [],
      action: 'CONSIDER',
      confidence: 0.9,
    };
    const parsed = parseStructured(screenResultSchema, JSON.stringify(withAdvice));

    // Extra keys are dropped, so the cheap stage's output carries no advice
    // even if the model volunteers some.
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect('action' in parsed.value).toBe(false);
  });

  it('keeps the set-aside list, so nothing vanishes silently', () => {
    const parsed = parseStructured(
      screenResultSchema,
      JSON.stringify({
        shortlist: [],
        setAside: [{ symbol: 'MSFT', reason: 'not enough history to judge' }],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.setAside[0]?.symbol).toBe('MSFT');
  });
});
