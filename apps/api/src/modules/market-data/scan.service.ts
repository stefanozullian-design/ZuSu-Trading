import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { IndicatorService } from './indicator.service.js';
import {
  SCAN_FIELDS,
  SCAN_OPERATORS,
  describeCondition,
  runScan,
  type ScanCondition,
  type ScanOutcome,
} from './scanner.js';
import { TIMEFRAMES, type Timeframe } from './types.js';
import type { WatchlistService } from './watchlist.service.js';

/**
 * Saved scans and their execution (§9).
 *
 * Conditions live in a JSON column, so they are parsed through zod on the way
 * out as well as on the way in. A stored scan whose shape no longer validates
 * is reported as broken rather than half-evaluated — a filter that silently
 * dropped a condition it could not read would return matches that do not meet
 * the criteria the user thinks they asked for.
 */

const operandSchema = z.union([
  z.object({
    // Refused here rather than left to the evaluator. A typo in a threshold
    // would otherwise surface as "no symbol could be evaluated", which reads
    // like missing data instead of a mistake the user can fix.
    constant: z
      .string()
      .min(1)
      .max(32)
      .refine((value) => Number.isFinite(Number(value)), {
        message: 'must be a number',
      }),
  }),
  z.object({ field: z.enum(SCAN_FIELDS) }),
]);

export const scanConditionSchema = z.object({
  field: z.enum(SCAN_FIELDS),
  operator: z.enum(SCAN_OPERATORS),
  operand: operandSchema,
  operandUpper: operandSchema.optional(),
});

export const scanConditionsSchema = z.array(scanConditionSchema).max(12);

export interface ScanDefinitionView {
  id: string;
  name: string;
  description: string | null;
  timeframe: Timeframe;
  conditions: ScanCondition[];
  /** Each condition in words, so a saved scan is readable at a glance. */
  summary: string[];
  watchlistId: string | null;
  lastRunAt: Date | null;
  updatedAt: Date;
}

export interface ScanRunResult extends ScanOutcome {
  timeframe: Timeframe;
  /** Symbols the scan covered. */
  universe: string[];
  summary: string[];
  ranAt: Date;
}

export class ScanService {
  constructor(
    private readonly db: PrismaClient,
    private readonly indicators: IndicatorService,
    private readonly watchlists: WatchlistService,
  ) {}

  async list(): Promise<ScanDefinitionView[]> {
    const rows = await this.db.scanDefinition.findMany({ orderBy: { name: 'asc' } });
    return rows.map((row) => this.toView(row));
  }

  async get(id: string): Promise<ScanDefinitionView> {
    const row = await this.db.scanDefinition.findUnique({ where: { id } });
    if (!row) throw new AppError('NOT_FOUND', 'Scan not found');
    return this.toView(row);
  }

  async create(input: {
    name: string;
    description?: string | null;
    timeframe: Timeframe;
    conditions: ScanCondition[];
    watchlistId?: string | null;
    createdBy?: string | null;
  }): Promise<ScanDefinitionView> {
    const name = input.name.trim();
    if (!name) throw new AppError('VALIDATION_FAILED', 'A scan needs a name');
    this.assertConditions(input.conditions);

    const existing = await this.db.scanDefinition.findUnique({ where: { name } });
    if (existing) throw new AppError('CONFLICT', `A scan named "${name}" already exists`);

    const row = await this.db.scanDefinition.create({
      data: {
        name,
        description: input.description ?? null,
        timeframe: input.timeframe,
        // Prisma types a JSON column as InputJsonValue; the shape is already
        // validated by `assertConditions` above.
        conditions: input.conditions as unknown as Prisma.InputJsonValue,
        watchlistId: input.watchlistId ?? null,
        createdBy: input.createdBy ?? null,
      },
    });
    return this.toView(row);
  }

  async update(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      timeframe?: Timeframe;
      conditions?: ScanCondition[];
      watchlistId?: string | null;
    },
  ): Promise<ScanDefinitionView> {
    await this.get(id);
    if (input.conditions) this.assertConditions(input.conditions);

    const row = await this.db.scanDefinition.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.timeframe !== undefined && { timeframe: input.timeframe }),
        ...(input.conditions !== undefined && {
          conditions: input.conditions as unknown as Prisma.InputJsonValue,
        }),
        ...(input.watchlistId !== undefined && { watchlistId: input.watchlistId }),
      },
    });
    return this.toView(row);
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.db.scanDefinition.delete({ where: { id } });
  }

  /**
   * Runs a filter without saving it.
   *
   * `barLimit` bounds how much history each symbol is evaluated over. It has to
   * be generous enough for the slowest indicator referenced to have warmed up —
   * a 50-period average over 30 bars is not a non-match, it is unevaluable, and
   * the result says so.
   */
  async run(input: {
    timeframe: Timeframe;
    conditions: ScanCondition[];
    watchlistId?: string | null;
    barLimit?: number;
  }): Promise<ScanRunResult> {
    this.assertConditions(input.conditions);

    const universe = await this.watchlists.symbolsFor(input.watchlistId ?? null);
    const entries = [];
    for (const symbol of universe) {
      entries.push({
        symbol,
        series: await this.indicators.series(symbol, input.timeframe, {
          limit: input.barLimit ?? 200,
        }),
      });
    }

    const outcome = runScan(entries, input.conditions);
    return {
      ...outcome,
      timeframe: input.timeframe,
      universe,
      summary: input.conditions.map(describeCondition),
      ranAt: new Date(),
    };
  }

  /** Runs a saved scan and records when it last ran. */
  async runSaved(id: string, options: { barLimit?: number } = {}): Promise<ScanRunResult> {
    const definition = await this.get(id);
    const result = await this.run({
      timeframe: definition.timeframe,
      conditions: definition.conditions,
      watchlistId: definition.watchlistId,
      barLimit: options.barLimit,
    });
    await this.db.scanDefinition.update({
      where: { id },
      data: { lastRunAt: result.ranAt },
    });
    return result;
  }

  private assertConditions(conditions: unknown): ScanCondition[] {
    const parsed = scanConditionsSchema.safeParse(conditions);
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', 'Scan conditions are not valid', {
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    for (const condition of parsed.data) {
      if (condition.operator === 'between' && !condition.operandUpper) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${condition.field} between" needs an upper bound`,
        );
      }
    }
    return parsed.data as ScanCondition[];
  }

  private toView(row: {
    id: string;
    name: string;
    description: string | null;
    timeframe: string;
    conditions: unknown;
    watchlistId: string | null;
    lastRunAt: Date | null;
    updatedAt: Date;
  }): ScanDefinitionView {
    const parsed = scanConditionsSchema.safeParse(row.conditions);
    if (!parsed.success) {
      // Stored data that no longer validates. Refusing to read it is the
      // honest outcome: evaluating a filter we cannot fully parse would
      // produce matches against criteria nobody chose.
      throw new AppError(
        'INTERNAL',
        `Saved scan "${row.name}" has conditions this version cannot read`,
      );
    }
    if (!(TIMEFRAMES as readonly string[]).includes(row.timeframe)) {
      throw new AppError('INTERNAL', `Saved scan "${row.name}" has an unknown timeframe`);
    }

    const conditions = parsed.data as ScanCondition[];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      timeframe: row.timeframe as Timeframe,
      conditions,
      summary: conditions.map(describeCondition),
      watchlistId: row.watchlistId,
      lastRunAt: row.lastRunAt,
      updatedAt: row.updatedAt,
    };
  }
}
