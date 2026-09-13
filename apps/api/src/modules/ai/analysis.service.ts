import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { dec } from '@zusu/shared';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { IndicatorService } from '../market-data/indicator.service.js';
import type { Timeframe } from '../market-data/types.js';
import { BudgetGovernor } from './budget.js';
import { ANALYSIS_MODEL, SCREEN_MODEL, costOf } from './pricing.js';
import {
  AnalysisAction,
  AnalysisError,
  analysisResultSchema,
  screenResultSchema,
  type AnalysisProvider,
  type AnalysisResult,
  type CompletionResponse,
  type ScreenResult,
} from './types.js';

/**
 * The analysis engine (§50–§56).
 *
 * Two stages, because the alternative is either expensive or shallow: a cheap
 * model screens a whole watchlist down to a shortlist, and a larger one
 * analyses only what survived. The screen cannot produce advice — its schema
 * has no field for it — so the cheap stage decides where to look and never
 * what to do.
 *
 * The rules this module is arranged around:
 *
 *   1. **A model can recommend; a person authorises.** An analysis attaches to
 *      a signal as advice and nothing more. There is no method here that
 *      approves a signal, sizes an order or changes a strategy, and the output
 *      schema cannot express an instruction to trade.
 *
 *   2. **Unparseable output is a failure, not a partial success.** The raw text
 *      is stored, `responseValid` is false, the error is recorded, and the run
 *      contributes no advice. A half-read JSON object is the one way a model
 *      could smuggle a number into a trading decision.
 *
 *   3. **Every call is costed and budgeted before it is made.** A call that
 *      would cross the daily budget or the hourly ceiling is refused and the
 *      refusal is returned, not thrown away.
 *
 *   4. **The context is assembled here, from stored data.** The model sees
 *      indicator values and a rule trace — never a database handle, an API key
 *      or a free-form conversation. Nothing it returns is executed.
 */

const SCREEN_SYSTEM = `You screen equity symbols for a human trader.

You will receive a list of symbols with indicator values as of the most recent
closed bar. Your only job is to say which are worth a closer look and which are
not, with one short reason each.

You are not recommending trades. You cannot place, size or approve anything.
A person reads your shortlist and decides what to examine.

Reply with JSON only, matching exactly:
{"shortlist":[{"symbol":"AAPL","reason":"..."}],"setAside":[{"symbol":"X","reason":"..."}]}

Every symbol you were given must appear in exactly one of the two lists. If the
data given is not enough to judge a symbol, set it aside and say so.`;

const ANALYSIS_SYSTEM = `You analyse one equity setup for a human trader who
will decide whether to act.

You will receive indicator values as of the most recent closed bar, the rule
that produced the signal and whether each of its conditions held.

Rules you must follow:
- You are advising, not instructing. You cannot place, size or approve a trade,
  and nothing you return is executed.
- If the context is not enough to judge, answer INSUFFICIENT_CONTEXT and list
  what was missing. That is a useful answer, not a failure.
- Say what would make you wrong.

Reply with JSON only, matching exactly:
{"action":"CONSIDER"|"AVOID"|"INSUFFICIENT_CONTEXT","confidence":0.0-1.0,
 "riskLevel":"LOW"|"MEDIUM"|"HIGH","rationale":"...","invalidation":"...",
 "missingContext":["..."],"regime":"TRENDING"|"RANGE_BOUND"|"HIGH_VOLATILITY"|
 "LOW_VOLATILITY"|"BULLISH"|"BEARISH"|"NEUTRAL"|"RISK_ON"|"RISK_OFF"|null}`;

export interface AnalysisView {
  id: string;
  signalId: string | null;
  portfolioId: string | null;
  model: string;
  purpose: string;
  responseValid: boolean;
  validationError: string | null;
  action: string | null;
  confidence: string | null;
  riskLevel: string | null;
  regime: string | null;
  rationale: string | null;
  invalidation: string | null;
  missingContext: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  latencyMs: number | null;
  createdAt: Date;
}

export interface SpendSummary {
  spentTodayUsd: string;
  callsLastHour: number;
  limits: { dailyUsd: string; callsPerHour: number; maxOutputTokensPerCall: number };
  providerConfigured: boolean;
  providerName: string;
}

export class AnalysisService {
  private readonly budget: BudgetGovernor;

  constructor(
    private readonly db: PrismaClient,
    private readonly provider: AnalysisProvider,
    private readonly indicators: IndicatorService,
    budget?: BudgetGovernor,
  ) {
    this.budget = budget ?? new BudgetGovernor(db);
  }

  async spend(at: Date = new Date()): Promise<SpendSummary> {
    const [spent, calls] = await Promise.all([
      this.budget.spentToday(at),
      this.budget.callsLastHour(at),
    ]);
    return {
      spentTodayUsd: spent.toString(),
      callsLastHour: calls,
      limits: this.budget.configured,
      providerConfigured: this.provider.isConfigured(),
      providerName: this.provider.name,
    };
  }

  async list(
    options: { portfolioId?: string; signalId?: string; limit?: number } = {},
  ): Promise<AnalysisView[]> {
    const rows = await this.db.aiAnalysis.findMany({
      where: {
        ...(options.portfolioId ? { portfolioId: options.portfolioId } : {}),
        ...(options.signalId ? { signalId: options.signalId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: options.limit ?? 25,
    });
    return rows.map(toView);
  }

  /**
   * Stage one: screens a list of symbols down to a shortlist.
   *
   * Cheap model, no reasoning step, and an output schema that cannot recommend a
   * trade. Symbols the screen sets aside are returned with their reason, so a
   * shortlist of two out of twenty is inspectable rather than mysterious.
   */
  async screen(input: {
    symbols: string[];
    timeframe?: Timeframe;
    portfolioId?: string | null;
    at?: Date;
  }): Promise<{
    result: ScreenResult | null;
    analysisId: string;
    refusal: string | null;
  }> {
    if (input.symbols.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'Give at least one symbol to screen');
    }

    const timeframe = input.timeframe ?? '5m';
    const context = await this.contextFor(input.symbols, timeframe);
    const user = JSON.stringify({ timeframe, symbols: context });

    return this.run({
      purpose: 'SCREEN',
      model: SCREEN_MODEL,
      system: SCREEN_SYSTEM,
      user,
      maxOutputTokens: 1_000,
      thinking: 'off',
      schema: screenResultSchema,
      portfolioId: input.portfolioId ?? null,
      signalId: null,
      ...(input.at !== undefined && { at: input.at }),
    });
  }

  /**
   * Stage two: analyses one signal.
   *
   * The result is stored against the signal as advice. Nothing about the
   * signal's status changes: a person still has to approve it, and an analysis
   * saying CONSIDER with high confidence has exactly as much authority as one
   * saying AVOID — which is none.
   */
  async analyseSignal(input: { signalId: string; at?: Date }): Promise<{
    result: AnalysisResult | null;
    analysisId: string;
    refusal: string | null;
  }> {
    const signal = await this.db.signal.findUnique({
      where: { id: input.signalId },
      include: { strategy: { select: { name: true } } },
    });
    if (!signal) throw new AppError('NOT_FOUND', 'Signal not found');

    // The timeframe lives on the strategy version's definition, not on the
    // signal: a signal is about a bar, and which bar depends on the rule that
    // produced it.
    const timeframe = await this.timeframeFor(signal.strategyVersionId);
    const [context] = await this.contextFor([signal.symbol], timeframe);

    const user = JSON.stringify({
      symbol: signal.symbol,
      direction: signal.direction,
      timeframe,
      strategy: signal.strategy?.name ?? null,
      referencePrice: signal.referencePrice.toString(),
      suggestedStop: signal.suggestedStop?.toString() ?? null,
      suggestedTarget: signal.suggestedTarget?.toString() ?? null,
      // The rule and which of its conditions held, so the model is judging the
      // same evidence the person will see rather than a summary of it.
      ruleTrace: signal.conditionSnapshot,
      indicators: context ?? null,
    });

    return this.run({
      purpose: 'SIGNAL_ANALYSIS',
      model: ANALYSIS_MODEL,
      system: ANALYSIS_SYSTEM,
      user,
      maxOutputTokens: 1_500,
      thinking: 'adaptive',
      schema: analysisResultSchema,
      portfolioId: signal.portfolioId,
      signalId: signal.id,
      ...(input.at !== undefined && { at: input.at }),
    });
  }

  // --------------------------------------------------------------------------

  /**
   * Makes one governed, costed, schema-validated call.
   *
   * Every path through this method writes a row: a budget refusal, a provider
   * error and an unparseable reply are all stored, because "the analysis did
   * not happen" needs to be as visible as one that did.
   */
  private async run<T>(input: {
    purpose: string;
    model: string;
    system: string;
    user: string;
    maxOutputTokens: number;
    thinking: 'adaptive' | 'off';
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    portfolioId: string | null;
    signalId: string | null;
    at?: Date;
  }): Promise<{ result: T | null; analysisId: string; refusal: string | null }> {
    const at = input.at ?? new Date();
    const correlationId = randomUUID();
    const requestPayload = {
      model: input.model,
      system: input.system,
      user: input.user,
      maxOutputTokens: input.maxOutputTokens,
      thinking: input.thinking,
    };

    if (!this.provider.isConfigured()) {
      const row = await this.record({
        ...input,
        correlationId,
        requestPayload,
        responsePayload: null,
        responseValid: false,
        validationError:
          'No analysis provider is configured (ANTHROPIC_API_KEY is unset), so no call was made.',
        usage: null,
        latencyMs: null,
        costUsd: null,
      });
      return { result: null, analysisId: row.id, refusal: row.validationError };
    }

    const decision = await this.budget.check({
      model: input.model,
      prompt: `${input.system}\n${input.user}`,
      maxOutputTokens: input.maxOutputTokens,
      at,
    });

    if (!decision.allowed) {
      // A refusal is a row. A budget stop that left no trace would look
      // identical to a model that had nothing to say.
      const row = await this.record({
        ...input,
        correlationId,
        requestPayload,
        responsePayload: { budget: decision } as unknown as Prisma.InputJsonValue,
        responseValid: false,
        validationError: `Refused by the spend governor: ${decision.reason ?? 'unknown reason'}`,
        usage: null,
        latencyMs: null,
        costUsd: null,
      });
      return { result: null, analysisId: row.id, refusal: row.validationError };
    }

    let response: CompletionResponse;
    try {
      response = await this.provider.complete({
        model: input.model,
        system: input.system,
        user: input.user,
        maxOutputTokens: input.maxOutputTokens,
        thinking: input.thinking,
      });
    } catch (error) {
      const message =
        error instanceof AnalysisError
          ? `${error.message}${error.retryable ? ' (retryable)' : ''}`
          : error instanceof Error
            ? error.message
            : 'the provider call failed';
      const row = await this.record({
        ...input,
        correlationId,
        requestPayload,
        responsePayload: null,
        responseValid: false,
        validationError: message,
        usage: null,
        latencyMs: null,
        costUsd: null,
      });
      return { result: null, analysisId: row.id, refusal: message };
    }

    const cost = costOf(response.model, response.usage);
    const parsed = parseStructured(input.schema, response.text);

    const row = await this.record({
      ...input,
      correlationId,
      requestPayload,
      responsePayload: {
        text: response.text,
        stopReason: response.stopReason,
        ...(parsed.ok ? { parsed: parsed.value } : {}),
      } as unknown as Prisma.InputJsonValue,
      responseValid: parsed.ok,
      validationError: parsed.ok ? null : parsed.error,
      usage: response.usage,
      latencyMs: response.latencyMs,
      costUsd: cost.toString(),
      ...(parsed.ok ? { structured: parsed.value } : {}),
    });

    return {
      result: parsed.ok ? parsed.value : null,
      analysisId: row.id,
      refusal: parsed.ok ? null : parsed.error,
    };
  }

  private async record(input: {
    purpose: string;
    model: string;
    portfolioId: string | null;
    signalId: string | null;
    correlationId: string;
    requestPayload: unknown;
    responsePayload: Prisma.InputJsonValue | null;
    responseValid: boolean;
    validationError: string | null;
    usage: { inputTokens: number; outputTokens: number } | null;
    latencyMs: number | null;
    costUsd: string | null;
    structured?: unknown;
  }): Promise<{ id: string; validationError: string | null }> {
    const structured = input.structured as Partial<AnalysisResult> | undefined;

    const row = await this.db.aiAnalysis.create({
      data: {
        portfolioId: input.portfolioId,
        signalId: input.signalId,
        correlationId: input.correlationId,
        model: input.model,
        purpose: input.purpose,
        requestPayload: input.requestPayload as Prisma.InputJsonValue,
        responsePayload: input.responsePayload ?? undefined,
        responseValid: input.responseValid,
        validationError: input.validationError,
        action: structured?.action ?? null,
        confidence:
          structured?.confidence !== undefined ? dec(structured.confidence).toString() : null,
        riskLevel: structured?.riskLevel ?? null,
        marketRegime: structured?.regime ?? null,
        inputTokens: input.usage?.inputTokens ?? null,
        outputTokens: input.usage?.outputTokens ?? null,
        costUsd: input.costUsd,
        latencyMs: input.latencyMs,
      },
    });

    // A regime the model was willing to name is stored with its inputs, so a
    // later reader can see what the classification rested on.
    if (structured?.regime) {
      await this.db.marketRegime.create({
        data: {
          marketCode: 'XNYS',
          regime: structured.regime,
          confidence: dec(structured.confidence ?? 0).toString(),
          inputs: {
            source: 'analysis',
            analysisId: row.id,
            model: input.model,
          } as unknown as Prisma.InputJsonValue,
          detectedAt: row.createdAt,
        },
      });
    }

    return { id: row.id, validationError: row.validationError };
  }

  private async timeframeFor(strategyVersionId: string | null): Promise<Timeframe> {
    if (!strategyVersionId) return '5m';
    const version = await this.db.strategyVersion.findUnique({
      where: { id: strategyVersionId },
      select: { definition: true },
    });
    const definition = version?.definition as { timeframe?: string } | null;
    const timeframe = definition?.timeframe;
    return (timeframe ?? '5m') as Timeframe;
  }

  /** Indicator values as of the newest stored bar, per symbol. */
  private async contextFor(
    symbols: string[],
    timeframe: Timeframe,
  ): Promise<Record<string, unknown>[]> {
    const context: Record<string, unknown>[] = [];
    for (const symbol of symbols) {
      const snapshot = await this.indicators.snapshot(symbol, timeframe);
      if (!snapshot) {
        // Named rather than omitted: a symbol the model was never shown must
        // not look like one it declined.
        context.push({ symbol, error: 'no stored bars for this symbol' });
        continue;
      }
      context.push({
        symbol,
        asOf: snapshot.asOf.toISOString(),
        barsAvailable: snapshot.barsAvailable,
        // Nulls are sent as nulls. A warm-up value replaced with a zero would
        // be a fabricated indicator, and the model would reason from it as
        // though it were real.
        values: {
          close: snapshot.close.toString(),
          sma20: snapshot.sma20?.toString() ?? null,
          sma50: snapshot.sma50?.toString() ?? null,
          ema12: snapshot.ema12?.toString() ?? null,
          ema26: snapshot.ema26?.toString() ?? null,
          rsi14: snapshot.rsi14?.toString() ?? null,
          macd: snapshot.macd?.toString() ?? null,
          macdSignal: snapshot.macdSignal?.toString() ?? null,
          macdHistogram: snapshot.macdHistogram?.toString() ?? null,
          bollingerUpper: snapshot.bollingerUpper?.toString() ?? null,
          bollingerMiddle: snapshot.bollingerMiddle?.toString() ?? null,
          bollingerLower: snapshot.bollingerLower?.toString() ?? null,
          atr14: snapshot.atr14?.toString() ?? null,
          vwap: snapshot.vwap?.toString() ?? null,
          stochasticK: snapshot.stochasticK?.toString() ?? null,
          stochasticD: snapshot.stochasticD?.toString() ?? null,
        },
      });
    }
    return context;
  }
}

/**
 * Parses a model reply against a schema.
 *
 * Tolerant about the wrapper — a fenced code block or surrounding prose is
 * common and harmless — and strict about the content. If the object does not
 * match, this reports the failure rather than repairing it: a repaired
 * response is one nobody can audit.
 */
export function parseStructured<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  const candidate = extractJson(text);
  if (candidate === null) {
    return { ok: false, error: 'The reply contained no JSON object.' };
  }

  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (error) {
    return {
      ok: false,
      error: `The reply's JSON did not parse: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: `The reply did not match the expected shape — ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/** The first balanced JSON object in a string, ignoring any wrapper. */
function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function toView(row: {
  id: string;
  signalId: string | null;
  portfolioId: string | null;
  model: string;
  purpose: string;
  responseValid: boolean;
  validationError: string | null;
  action: string | null;
  confidence: { toString(): string } | null;
  riskLevel: string | null;
  marketRegime: string | null;
  responsePayload: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: { toString(): string } | null;
  latencyMs: number | null;
  createdAt: Date;
}): AnalysisView {
  const payload = (row.responsePayload ?? null) as {
    parsed?: { rationale?: string; invalidation?: string; missingContext?: string[] };
  } | null;

  return {
    id: row.id,
    signalId: row.signalId,
    portfolioId: row.portfolioId,
    model: row.model,
    purpose: row.purpose,
    responseValid: row.responseValid,
    validationError: row.validationError,
    action: row.action,
    confidence: row.confidence ? row.confidence.toString() : null,
    riskLevel: row.riskLevel,
    regime: row.marketRegime,
    rationale: payload?.parsed?.rationale ?? null,
    invalidation: payload?.parsed?.invalidation ?? null,
    missingContext: payload?.parsed?.missingContext ?? [],
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd ? row.costUsd.toString() : null,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt,
  };
}

/** Exported so the routes can describe what a model is allowed to do. */
export const ANALYSIS_ACTIONS = AnalysisAction;
