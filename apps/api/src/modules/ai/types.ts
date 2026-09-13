import { z } from 'zod';

/**
 * The analysis abstraction (§50–§56).
 *
 * Nothing outside this folder knows which model provider is in use, exactly as
 * nothing outside `modules/broker` knows which venue is.
 *
 * Three rules the interface exists to enforce:
 *
 *   1. **Structured output or nothing.** A response is parsed against a schema
 *      and a failure is stored as a failure. There is no "mostly parsed"
 *      state: a run whose output did not validate contributes no advice, and
 *      the row records why.
 *
 *   2. **A model can recommend, never authorise.** The output schema has no
 *      field that could place, size or approve a trade. The strongest thing a
 *      model can say is a recommendation with a confidence, attached to a
 *      signal a person still has to approve.
 *
 *   3. **Every call carries its cost.** Tokens in, tokens out, the price at
 *      the time and the latency. A provider that cannot report usage is one
 *      whose spend cannot be capped, and this platform caps spend.
 */

export const AnalysisAction = {
  /** Worth a person's attention, with reasons. */
  CONSIDER: 'CONSIDER',
  /** Explicitly not worth acting on, with reasons. */
  AVOID: 'AVOID',
  /** The context given was not enough to judge. Never treated as a no. */
  INSUFFICIENT_CONTEXT: 'INSUFFICIENT_CONTEXT',
} as const;
export type AnalysisAction = (typeof AnalysisAction)[keyof typeof AnalysisAction];

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * The screen stage's output: cheap, terse, and only a shortlist.
 *
 * Deliberately incapable of producing advice. A screen exists to decide what is
 * worth spending a larger model on, and letting it also say "buy" would make
 * the cheap stage the deciding one.
 */
export const screenResultSchema = z.object({
  shortlist: z
    .array(
      z.object({
        symbol: z.string().min(1).max(12),
        /** Why this one is worth a closer look, in one line. */
        reason: z.string().min(3).max(200),
      }),
    )
    .max(50),
  /** Symbols the screen explicitly set aside, so nothing vanishes silently. */
  setAside: z
    .array(
      z.object({
        symbol: z.string().min(1).max(12),
        reason: z.string().min(3).max(200),
      }),
    )
    .max(200)
    .default([]),
});
export type ScreenResult = z.infer<typeof screenResultSchema>;

/**
 * The analysis stage's output.
 *
 * Note what is absent: no quantity, no order type, no "execute" flag. The
 * schema cannot express an instruction to trade, which is a stronger guarantee
 * than a rule saying the platform will not follow one.
 */
export const analysisResultSchema = z.object({
  action: z.enum([
    AnalysisAction.CONSIDER,
    AnalysisAction.AVOID,
    AnalysisAction.INSUFFICIENT_CONTEXT,
  ]),
  /** 0–1. Required, because an opinion without one cannot be weighed. */
  confidence: z.number().min(0).max(1),
  riskLevel: z.enum(RISK_LEVELS),
  /** The reasoning, shown to the person deciding. */
  rationale: z.string().min(10).max(4000),
  /** What would have to be true for this to be wrong. */
  invalidation: z.string().min(5).max(1000),
  /** Facts the model was missing and would have wanted. */
  missingContext: z.array(z.string().max(200)).max(20).default([]),
  /** The regime the model believes the market is in, if it will say. */
  regime: z
    .enum([
      'TRENDING',
      'RANGE_BOUND',
      'HIGH_VOLATILITY',
      'LOW_VOLATILITY',
      'BULLISH',
      'BEARISH',
      'NEUTRAL',
      'RISK_ON',
      'RISK_OFF',
    ])
    .nullable()
    .default(null),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionRequest {
  /** Which model to call. The caller chooses; the adapter never substitutes. */
  model: string;
  system: string;
  /** The structured context. Never a free-form conversation. */
  user: string;
  maxOutputTokens: number;
  /**
   * Whether the model reasons before answering.
   *
   * Replaces `temperature`, which the current models reject. The screen is a
   * classification and wants none; the analysis is read by someone deciding
   * whether to commit money and gets `adaptive`.
   */
  thinking: 'adaptive' | 'off';
}

export interface CompletionResponse {
  /** The raw text, before any parsing. Stored as returned. */
  text: string;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
  stopReason: string | null;
}

export interface AnalysisProvider {
  readonly name: string;
  /** True when the provider has what it needs to make a call. */
  isConfigured(): boolean;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/** Raised when a provider call fails in a way the caller must not treat as advice. */
export class AnalysisError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AnalysisError';
  }
}
