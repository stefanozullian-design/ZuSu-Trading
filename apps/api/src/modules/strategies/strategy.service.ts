import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ExecutionMode,
  STRATEGY_STAGE_TRANSITIONS,
  StrategyStage,
  TradingSessionScope,
  assertStrategyStageTransition,
  isStrategyDefinitionFrozen,
} from '@zusu/shared';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { TIMEFRAMES } from '../market-data/types.js';
import { describeRule, fieldsUsed, ruleNodeSchema } from './rule-tree.js';

/**
 * Strategies and their versions (§10).
 *
 * Two rules shape everything here:
 *
 *   1. **A definition is versioned, never edited.** Changing an approved
 *      strategy means adding a version, which starts back at DRAFT and climbs
 *      the ladder again. The database enforces it with a trigger; this service
 *      refuses earlier with a message that says what to do instead.
 *
 *   2. **Every promotion is an act by a person.** The stage machine in
 *      `@zusu/shared` will not skip steps, approval records who signed it, and
 *      going live is a separate step from being approved — so "approved" never
 *      silently means "running".
 */

const stopSchema = z.object({
  kind: z.enum(['PERCENT', 'ATR']),
  value: z.string().refine((v) => Number(v) > 0, { message: 'must be a positive number' }),
});

const targetSchema = z.object({
  kind: z.enum(['PERCENT', 'ATR', 'RISK_MULTIPLE']),
  value: z.string().refine((v) => Number(v) > 0, { message: 'must be a positive number' }),
});

export const strategyDefinitionSchema = z.object({
  timeframe: z.enum(TIMEFRAMES),
  /** Null scans every tradable instrument. */
  watchlistId: z.string().uuid().nullable(),
  entry: z.object({
    direction: z.enum(['LONG', 'SHORT']),
    when: ruleNodeSchema,
  }),
  /** Optional: without it, exits are the risk engine's stop and target only. */
  exit: z.object({ when: ruleNodeSchema }).nullable(),
  /**
   * A stop is optional on a draft and mandatory to be approved. Trading
   * without one is not a strategy, it is a bet, and the approval gate is where
   * that gets caught.
   */
  stop: stopSchema.nullable(),
  target: targetSchema.nullable(),
});

export type StrategyDefinition = z.infer<typeof strategyDefinitionSchema>;

export const riskSettingsSchema = z.object({
  maxConcurrentPositions: z.number().int().min(1).max(50).default(3),
  maxNotionalPerTrade: z
    .string()
    .refine((v) => Number(v) > 0, { message: 'must be a positive number' }),
  /** Minimum bars of history before the strategy may say anything. */
  minBars: z.number().int().min(2).max(2000).default(60),
});

export type RiskSettings = z.infer<typeof riskSettingsSchema>;

export interface StrategyVersionView {
  id: string;
  strategyId: string;
  version: number;
  stage: StrategyStage;
  changeDescription: string;
  /**
   * Null when this build cannot read the definition.
   *
   * Versions are immutable and kept forever, so a row written by an older
   * build whose rule language has since changed will exist. Refusing to read
   * it is right; refusing to show its stage and history alongside it would
   * mean one unreadable row hides every other version of the strategy.
   */
  definition: StrategyDefinition | null;
  riskSettings: RiskSettings | null;
  executionMode: ExecutionMode;
  sessionScope: TradingSessionScope;
  /** The entry rule in one line, or null when the definition is unreadable. */
  entrySummary: string | null;
  exitSummary: string | null;
  /** Indicators this version depends on, so a reader knows what it needs. */
  fieldsUsed: string[];
  /** True once the definition may no longer change. */
  frozen: boolean;
  authorId: string | null;
  approvedById: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export interface StrategyView {
  id: string;
  name: string;
  description: string | null;
  isArchived: boolean;
  versions: StrategyVersionView[];
  /** The version currently running, if any. */
  liveVersion: StrategyVersionView | null;
  /** The newest version, whatever its stage. */
  latestVersion: StrategyVersionView | null;
}

export class StrategyService {
  constructor(private readonly db: PrismaClient) {}

  async list(): Promise<StrategyView[]> {
    const rows = await this.db.strategy.findMany({
      orderBy: { name: 'asc' },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    return rows.map((row) => this.toView(row));
  }

  async get(id: string): Promise<StrategyView> {
    const row = await this.db.strategy.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!row) throw new AppError('NOT_FOUND', 'Strategy not found');
    return this.toView(row);
  }

  /** Creates a strategy together with version 1, at DRAFT. */
  async create(input: {
    name: string;
    description?: string | null;
    definition: StrategyDefinition;
    riskSettings: RiskSettings;
    changeDescription: string;
    authorId?: string | null;
  }): Promise<StrategyView> {
    const name = input.name.trim();
    if (!name) throw new AppError('VALIDATION_FAILED', 'A strategy needs a name');
    this.assertChangeDescription(input.changeDescription);

    const existing = await this.db.strategy.findUnique({ where: { name } });
    if (existing) throw new AppError('CONFLICT', `A strategy named "${name}" already exists`);

    const created = await this.db.strategy.create({
      data: {
        name,
        description: input.description ?? null,
        versions: {
          create: {
            version: 1,
            stage: StrategyStage.DRAFT,
            changeDescription: input.changeDescription.trim(),
            definition: input.definition as unknown as Prisma.InputJsonValue,
            riskSettings: input.riskSettings as unknown as Prisma.InputJsonValue,
            authorId: input.authorId ?? null,
          },
        },
      },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    return this.toView(created);
  }

  /**
   * Adds a new version. The only way to change a strategy's rules.
   *
   * Starts at DRAFT with `previousVersionId` set, so the lineage of a live
   * definition is recoverable — "what were we running in August" has an answer.
   */
  async addVersion(
    strategyId: string,
    input: {
      definition: StrategyDefinition;
      riskSettings: RiskSettings;
      changeDescription: string;
      authorId?: string | null;
    },
  ): Promise<StrategyVersionView> {
    this.assertChangeDescription(input.changeDescription);
    const strategy = await this.get(strategyId);
    if (strategy.isArchived) {
      throw new AppError('CONFLICT', 'This strategy is archived; unarchive it before changing it');
    }

    const latest = strategy.latestVersion;
    const created = await this.db.strategyVersion.create({
      data: {
        strategyId,
        version: (latest?.version ?? 0) + 1,
        stage: StrategyStage.DRAFT,
        changeDescription: input.changeDescription.trim(),
        definition: input.definition as unknown as Prisma.InputJsonValue,
        riskSettings: input.riskSettings as unknown as Prisma.InputJsonValue,
        previousVersionId: latest?.id ?? null,
        authorId: input.authorId ?? null,
      },
    });
    return this.toVersionView(created);
  }

  /**
   * Moves a version one step along the ladder.
   *
   * The stage machine refuses a skip. Two extra gates apply on the way to
   * APPROVED: a stop loss must be configured, and the approval is signed. A
   * strategy without a stop is not a strategy, and an approval nobody signed
   * is not an approval — the database checks the second independently.
   */
  async promote(
    versionId: string,
    to: StrategyStage,
    actor: { id: string },
  ): Promise<StrategyVersionView> {
    const existing = await this.db.strategyVersion.findUnique({ where: { id: versionId } });
    if (!existing) throw new AppError('NOT_FOUND', 'Strategy version not found');

    if (!strategyDefinitionSchema.safeParse(existing.definition).success) {
      throw new AppError(
        'CONFLICT',
        `Version ${String(existing.version)} was written in a rule language this build ` +
          'cannot read, so it cannot be promoted. Add a new version instead — promoting a ' +
          'definition nobody can evaluate would mean approving something unread.',
      );
    }

    const from = existing.stage as StrategyStage;
    try {
      assertStrategyStageTransition(from, to);
    } catch {
      const allowed = allowedNext(from);
      throw new AppError(
        'CONFLICT',
        allowed.length === 0
          ? `A ${from} version cannot be promoted any further.`
          : `A ${from} version can only move to ${allowed.join(' or ')}, not ${to}. ` +
              'The ladder exists so evidence accumulates before real money is involved.',
      );
    }

    if (to === StrategyStage.APPROVED) {
      const definition = this.parseDefinition(existing.definition, existing.version);
      if (!definition.stop) {
        throw new AppError(
          'RISK_REJECTED',
          'This version has no stop loss, so it cannot be approved. ' +
            'Trading without a stop is a bet, not a strategy.',
        );
      }
    }

    if (to === StrategyStage.LIVE) {
      const alreadyLive = await this.db.strategyVersion.findFirst({
        where: { strategyId: existing.strategyId, stage: StrategyStage.LIVE },
      });
      if (alreadyLive) {
        throw new AppError(
          'CONFLICT',
          `Version ${String(alreadyLive.version)} is already live. Retire it first — ` +
            'two live definitions would make "which rules are running" unanswerable.',
        );
      }
    }

    const updated = await this.db.strategyVersion.update({
      where: { id: versionId },
      data: {
        stage: to,
        ...(to === StrategyStage.APPROVED && {
          approvedById: actor.id,
          approvedAt: new Date(),
        }),
      },
    });
    return this.toVersionView(updated);
  }

  async archive(id: string, archived: boolean): Promise<StrategyView> {
    const strategy = await this.get(id);
    if (archived && strategy.liveVersion) {
      throw new AppError(
        'CONFLICT',
        'Retire the live version before archiving the strategy, so nothing keeps running unattended.',
      );
    }
    await this.db.strategy.update({ where: { id }, data: { isArchived: archived } });
    return this.get(id);
  }

  /** Every version currently live, across all strategies. */
  async liveVersions(): Promise<StrategyVersionView[]> {
    const rows = await this.db.strategyVersion.findMany({
      where: { stage: StrategyStage.LIVE },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toVersionView(row));
  }

  private assertChangeDescription(value: string): void {
    if (value.trim().length < 8) {
      // Matched by a database check constraint. "update" tells a future reader
      // nothing about why a definition changed.
      throw new AppError(
        'VALIDATION_FAILED',
        'Say what changed and why, in at least eight characters — a future reader has only this.',
      );
    }
  }

  private parseDefinition(raw: unknown, version: number): StrategyDefinition {
    const parsed = strategyDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        'INTERNAL',
        `Version ${String(version)} has a definition this build cannot read`,
      );
    }
    return parsed.data;
  }

  private toVersionView(row: {
    id: string;
    strategyId: string;
    version: number;
    stage: string;
    changeDescription: string;
    definition: unknown;
    riskSettings: unknown;
    executionMode: string;
    sessionScope: string;
    authorId: string | null;
    approvedById: string | null;
    approvedAt: Date | null;
    createdAt: Date;
  }): StrategyVersionView {
    const parsedDefinition = strategyDefinitionSchema.safeParse(row.definition);
    const parsedRisk = riskSettingsSchema.safeParse(row.riskSettings);
    const definition = parsedDefinition.success ? parsedDefinition.data : null;
    const riskSettings = parsedRisk.success ? parsedRisk.data : null;

    const entryFields = definition ? fieldsUsed(definition.entry.when) : [];
    const exitFields = definition?.exit ? fieldsUsed(definition.exit.when) : [];

    return {
      id: row.id,
      strategyId: row.strategyId,
      version: row.version,
      stage: row.stage as StrategyStage,
      changeDescription: row.changeDescription,
      definition,
      riskSettings,
      executionMode: row.executionMode as ExecutionMode,
      sessionScope: row.sessionScope as TradingSessionScope,
      entrySummary: definition
        ? `${definition.entry.direction} when ${describeRule(definition.entry.when)}`
        : null,
      exitSummary: definition?.exit ? `exit when ${describeRule(definition.exit.when)}` : null,
      fieldsUsed: [...new Set([...entryFields, ...exitFields])].sort(),
      frozen: isStrategyDefinitionFrozen(row.stage as StrategyStage),
      authorId: row.authorId,
      approvedById: row.approvedById,
      approvedAt: row.approvedAt,
      createdAt: row.createdAt,
    };
  }

  private toView(row: {
    id: string;
    name: string;
    description: string | null;
    isArchived: boolean;
    versions: Parameters<StrategyService['toVersionView']>[0][];
  }): StrategyView {
    const versions = row.versions.map((version) => this.toVersionView(version));
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      isArchived: row.isArchived,
      versions,
      liveVersion: versions.find((v) => v.stage === StrategyStage.LIVE) ?? null,
      latestVersion: versions[0] ?? null,
    };
  }
}

/** Read from the shared table rather than restated, so the two cannot drift. */
function allowedNext(from: StrategyStage): readonly StrategyStage[] {
  return STRATEGY_STAGE_TRANSITIONS[from];
}
