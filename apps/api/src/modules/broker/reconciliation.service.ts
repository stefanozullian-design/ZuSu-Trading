import type { Prisma, PrismaClient } from '@prisma/client';
import { Decimal, dec } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import type { BrokerRegistry } from './broker-registry.js';

/**
 * Reconciliation (§26).
 *
 * Two independent records of the same account — the broker's and this
 * platform's — compared field by field. The rule that makes it worth running:
 * **it never writes a correction.** A mismatch is a row and an alert, and a
 * person decides what the truth is, because a reconciler that silently
 * overwrites one side turns a bug into a rewritten history.
 *
 * What it looks for:
 *
 *   - **Cash and position drift.** A quantity or an average price that differs
 *     by more than a threshold, per symbol, in either direction.
 *   - **Positions the broker has and this platform does not** — usually an
 *     order placed somewhere else, sometimes a fill this platform missed.
 *   - **Positions this platform has and the broker does not** — the worse
 *     case, because it means the platform thinks it is in a trade it is not.
 *   - **Orders placed outside this platform.** Robinhood reports who placed
 *     each order, so an order a person made in the app is *identified* rather
 *     than adopted. Adopting it would attribute a human decision to a strategy.
 */

/** Below this, a difference is rounding rather than drift. */
const QUANTITY_TOLERANCE = dec('0.000001');
const PRICE_TOLERANCE = dec('0.01');

export interface Difference {
  kind:
    | 'CASH'
    | 'POSITION_QUANTITY'
    | 'POSITION_PRICE'
    | 'POSITION_MISSING_HERE'
    | 'POSITION_MISSING_AT_BROKER'
    | 'ORDER_PLACED_ELSEWHERE';
  symbol: string | null;
  ours: string | null;
  theirs: string | null;
  detail: string;
}

export interface ReconciliationResult {
  id: string;
  portfolioId: string;
  succeeded: boolean;
  cashMismatch: boolean;
  positionMismatch: boolean;
  orderMismatch: boolean;
  differences: Difference[];
  detail: string;
}

export class ReconciliationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly brokers: BrokerRegistry,
  ) {}

  /**
   * Compares one portfolio against its broker.
   *
   * Returns the differences and stores them. Nothing is corrected: the point
   * of two records is that they can disagree, and the disagreement is the
   * finding.
   */
  async run(portfolioId: string): Promise<ReconciliationResult> {
    const portfolio = await this.db.portfolio.findUnique({ where: { id: portfolioId } });
    if (!portfolio) throw new AppError('NOT_FOUND', 'Portfolio not found');

    const brokerAccount = await this.db.brokerAccount.findFirst({
      where: { portfolioId },
    });

    const broker = this.brokers.forPortfolio(portfolio);
    const differences: Difference[] = [];

    const [brokerPositions, ourPositions, brokerOrders] = await Promise.all([
      broker.getPositions(),
      this.db.position.findMany({ where: { portfolioId, status: 'OPEN' } }),
      broker.getOrders({ since: new Date(Date.now() - 7 * 86_400_000) }),
    ]);

    const account = await broker.getAccount();
    const ourCash = dec(portfolio.cashBalance.toString());
    const theirCash = account.cash;
    const cashMismatch = ourCash.minus(theirCash).abs().greaterThan(PRICE_TOLERANCE);
    if (cashMismatch) {
      differences.push({
        kind: 'CASH',
        symbol: null,
        ours: ourCash.toString(),
        theirs: theirCash.toString(),
        detail:
          `Cash differs by ${ourCash.minus(theirCash).abs().toFixed(2)}. Neither figure is ` +
          'corrected here; a person decides which is right.',
      });
    }

    const theirsBySymbol = new Map(brokerPositions.map((position) => [position.symbol, position]));
    const oursBySymbol = new Map(ourPositions.map((position) => [position.symbol, position]));

    for (const [symbol, theirs] of theirsBySymbol) {
      const ours = oursBySymbol.get(symbol);
      if (!ours) {
        differences.push({
          kind: 'POSITION_MISSING_HERE',
          symbol,
          ours: null,
          theirs: theirs.quantity.toString(),
          detail:
            `The broker holds ${theirs.quantity.toString()} ${symbol} that this platform has no ` +
            'record of — usually an order placed elsewhere, sometimes a fill that was missed.',
        });
        continue;
      }

      const ourQuantity = dec(ours.quantity.toString());
      if (ourQuantity.minus(theirs.quantity).abs().greaterThan(QUANTITY_TOLERANCE)) {
        differences.push({
          kind: 'POSITION_QUANTITY',
          symbol,
          ours: ourQuantity.toString(),
          theirs: theirs.quantity.toString(),
          detail: `${symbol}: this platform holds ${ourQuantity.toString()}, the broker reports ${theirs.quantity.toString()}.`,
        });
      }

      const ourPrice = dec(ours.averageEntryPrice.toString());
      if (ourPrice.minus(theirs.averageEntryPrice).abs().greaterThan(PRICE_TOLERANCE)) {
        differences.push({
          kind: 'POSITION_PRICE',
          symbol,
          ours: ourPrice.toString(),
          theirs: theirs.averageEntryPrice.toString(),
          detail:
            `${symbol}: average entry differs — ${ourPrice.toFixed(4)} here against ` +
            `${theirs.averageEntryPrice.toFixed(4)} at the broker. Cost basis drift changes every ` +
            'realised figure downstream.',
        });
      }
    }

    for (const [symbol, ours] of oursBySymbol) {
      if (theirsBySymbol.has(symbol)) continue;

      // An imported position is still reported. It was declared by a person
      // rather than traded, so the broker not holding it is *explainable* — but
      // "explainable" is not "fine", and the one thing reconciliation must
      // never do is decide for the reader which differences deserve their
      // attention. What provenance buys is a better sentence, not silence.
      const imported = ours.origin === 'IMPORTED';
      differences.push({
        kind: 'POSITION_MISSING_AT_BROKER',
        symbol,
        ours: ours.quantity.toString(),
        theirs: null,
        detail: imported
          ? `This platform holds ${ours.quantity.toString()} ${symbol} that the broker does not ` +
            `report. It was imported as already held on ` +
            `${ours.openedAt.toISOString().slice(0, 10)} rather than bought here, so no order ` +
            'explains it. Either the shares are at another broker, or the declaration was wrong.'
          : `This platform holds ${ours.quantity.toString()} ${symbol} that the broker does not ` +
            'report. This is the worse direction: the platform believes it is in a trade it is not.',
      });
    }

    // Orders this platform never placed. Identified, never adopted: attributing
    // a person's own trade to a strategy would corrupt every statistic about
    // that strategy.
    const ourKeys = new Set(
      (
        await this.db.order.findMany({
          where: { portfolioId },
          select: { idempotencyKey: true },
        })
      ).map((order) => order.idempotencyKey),
    );

    for (const order of brokerOrders) {
      if (order.clientOrderId && ourKeys.has(order.clientOrderId)) continue;
      differences.push({
        kind: 'ORDER_PLACED_ELSEWHERE',
        symbol: order.symbol,
        ours: null,
        theirs: `${order.side} ${order.requestedQty.toString()} (${order.status})`,
        detail:
          `${order.symbol}: an order at the broker that this platform did not place. It is real ` +
          'and it is not ours; it is reported rather than adopted.',
      });
    }

    const positionMismatch = differences.some((difference) =>
      difference.kind.startsWith('POSITION'),
    );
    const orderMismatch = differences.some(
      (difference) => difference.kind === 'ORDER_PLACED_ELSEWHERE',
    );

    const detail =
      differences.length === 0
        ? 'Cash, positions and orders agree.'
        : `${String(differences.length)} differences found. Nothing was corrected automatically.`;

    const stored = brokerAccount
      ? await this.db.reconciliation.create({
          data: {
            brokerAccountId: brokerAccount.id,
            finishedAt: new Date(),
            succeeded: differences.length === 0,
            cashMismatch,
            positionMismatch,
            orderMismatch,
            differences: differences as unknown as Prisma.InputJsonValue,
            detail,
          },
        })
      : null;

    if (differences.length > 0) {
      await this.db.riskEvent.create({
        data: {
          portfolioId,
          type: 'RECONCILIATION_MISMATCH',
          severity: positionMismatch ? 'CRITICAL' : 'WARNING',
          message: detail,
          metadata: { differences } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return {
      id: stored?.id ?? 'unstored',
      portfolioId,
      succeeded: differences.length === 0,
      cashMismatch,
      positionMismatch,
      orderMismatch,
      differences,
      detail:
        stored === null
          ? `${detail} (No broker account is linked to this portfolio, so the result was not stored.)`
          : detail,
    };
  }

  async recent(portfolioId: string, limit = 20): Promise<ReconciliationResult[]> {
    const brokerAccount = await this.db.brokerAccount.findFirst({
      where: { portfolioId },
    });
    if (!brokerAccount) return [];

    const rows = await this.db.reconciliation.findMany({
      where: { brokerAccountId: brokerAccount.id },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });

    return rows.map((row) => ({
      id: row.id,
      portfolioId,
      succeeded: row.succeeded,
      cashMismatch: row.cashMismatch,
      positionMismatch: row.positionMismatch,
      orderMismatch: row.orderMismatch,
      differences: (row.differences ?? []) as unknown as Difference[],
      detail: row.detail ?? '',
    }));
  }
}

/** Exported for tests: the tolerances below which a difference is rounding. */
export const TOLERANCES = { quantity: QUANTITY_TOLERANCE, price: PRICE_TOLERANCE };
export type { Decimal };
