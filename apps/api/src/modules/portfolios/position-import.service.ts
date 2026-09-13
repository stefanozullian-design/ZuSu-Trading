import type { Prisma, PrismaClient } from '@prisma/client';
import { Permission, TradingEnvironment, dec } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';

/**
 * Opening positions — shares a person already held before this platform was
 * watching (§44).
 *
 * Every other position in the system exists because a fill created it, which is
 * what makes each one traceable to a decision with a name and a timestamp. An
 * imported position has no such history and never will, so the design question
 * is not how to hide that but how to record it honestly:
 *
 *   - **The position is marked IMPORTED, permanently.** Nothing infers
 *     provenance from the absence of an order; readers that care ask directly.
 *     Reconciliation uses it to explain a difference rather than to suppress
 *     one — the broker genuinely may not hold what a person said they hold, and
 *     that is exactly the finding reconciliation exists to surface.
 *
 *   - **It arrives with a cash flow, and moves no cash.** Shares appearing from
 *     nowhere would raise the portfolio's equity, and a time-weighted return
 *     reads a rise in equity as performance. So the import records a
 *     `TRANSFER_IN` for the value it brought, which the return calculation
 *     subtracts exactly as it subtracts a deposit. Nobody's track record
 *     improves by remembering they own something.
 *
 *   - **It opens a tax lot.** Selling consumes lots first-in-first-out, and a
 *     position whose lots do not account for its shares is a bookkeeping fault
 *     the position book refuses to trade through. An import without a lot would
 *     work perfectly until the first sale.
 *
 *   - **It creates no order and no signal**, so it cannot contaminate any
 *     strategy's statistics. A strategy is judged on decisions it made.
 */

export interface ImportPositionInput {
  portfolioId: string;
  symbol: string;
  /** Shares held. Positive; this records holdings, not short positions. */
  quantity: string;
  /** What was paid per share, on average. */
  averageEntryPrice: string;
  /** When the shares were actually acquired — not when they were typed in. */
  acquiredAt: Date;
  note?: string | null;
}

export interface ImportedPositionView {
  id: string;
  portfolioId: string;
  symbol: string;
  quantity: string;
  averageEntryPrice: string;
  costBasis: string;
  acquiredAt: string;
  origin: 'IMPORTED';
  cashFlowId: string;
  detail: string;
}

export class PositionImportService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
    private readonly audit: AuditService,
  ) {}

  async importPosition(
    principal: Principal,
    input: ImportPositionInput,
  ): Promise<ImportedPositionView> {
    const portfolio = await this.access.assertPortfolioAccess(principal, input.portfolioId, {
      permission: Permission.PORTFOLIO_WRITE,
      requireTrade: true,
    });

    const symbol = input.symbol.trim().toUpperCase();
    const quantity = dec(input.quantity);
    const price = dec(input.averageEntryPrice);

    if (!quantity.isFinite() || quantity.lessThanOrEqualTo(0)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The quantity must be a positive number of shares. Recording a short position this way ' +
          'is not supported, because a borrow this platform never arranged is not a holding.',
      );
    }
    if (!price.isFinite() || price.lessThanOrEqualTo(0)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The average price paid must be positive. Without a real cost basis every gain and loss ' +
          'computed from this position afterwards would be wrong.',
      );
    }
    if (input.acquiredAt.getTime() > Date.now()) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The acquisition date is in the future. That is a typo, not a holding.',
      );
    }

    // One open position per symbol is a database invariant, so a second import
    // would fail deep inside a transaction with an index name for a message.
    const existing = await this.db.position.findFirst({
      where: { portfolioId: portfolio.id, symbol, status: 'OPEN' },
    });
    if (existing) {
      throw new AppError(
        'CONFLICT',
        `This portfolio already holds ${existing.quantity.toString()} ${symbol}. Importing ` +
          'again would create a second record of one holding, and the two would disagree ' +
          'from that moment on.',
      );
    }

    const instrument = await this.db.instrument.findUnique({ where: { symbol } });
    if (!instrument) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${symbol} is not an instrument this platform knows, so it could never be priced, ` +
          'charted or risk-checked. Add it to a watchlist first.',
      );
    }

    const costBasis = price.times(quantity);

    const created = await this.db.$transaction(async (tx) => {
      const position = await tx.position.create({
        data: {
          portfolioId: portfolio.id,
          symbol,
          assetClass: instrument.assetClass,
          status: 'OPEN',
          origin: 'IMPORTED',
          quantity: quantity.toString(),
          averageEntryPrice: price.toString(),
          // Deliberately not marked: the position is worth what the market says
          // today, and that is computed on read. Storing the entry price as a
          // mark would render a brand-new import as exactly break-even, which
          // is a claim rather than a measurement.
          openedAt: input.acquiredAt,
        },
      });

      await tx.positionLot.create({
        data: {
          positionId: position.id,
          quantity: quantity.toString(),
          remainingQty: quantity.toString(),
          costBasis: costBasis.toString(),
          openedAt: input.acquiredAt,
        },
      });

      // The counterweight. Without it the equity jump reads as a gain.
      const flow = await tx.cashFlow.create({
        data: {
          portfolioId: portfolio.id,
          type: 'TRANSFER_IN',
          amount: costBasis.toString(),
          occurredAt: input.acquiredAt,
          reference: position.id,
          note:
            input.note?.trim() ||
            `${quantity.toString()} ${symbol} transferred in at ${price.toFixed(4)} per share`,
        },
      });

      return { position, flow };
    });

    await this.audit.record({
      action: 'POSITION_IMPORTED',
      actorUserId: principal.id,
      actorType: 'USER',
      entityType: 'position',
      entityId: created.position.id,
      portfolioId: portfolio.id,
      environment: portfolio.environment as TradingEnvironment,
      after: {
        symbol,
        quantity: quantity.toString(),
        averageEntryPrice: price.toString(),
        acquiredAt: input.acquiredAt.toISOString(),
        origin: 'IMPORTED',
      },
      metadata: { costBasis: costBasis.toString() } as unknown as Record<string, unknown>,
    });

    return {
      id: created.position.id,
      portfolioId: portfolio.id,
      symbol,
      quantity: quantity.toString(),
      averageEntryPrice: price.toString(),
      costBasis: costBasis.toString(),
      acquiredAt: input.acquiredAt.toISOString(),
      origin: 'IMPORTED',
      cashFlowId: created.flow.id,
      detail:
        `${quantity.toString()} ${symbol} recorded at ${price.toFixed(4)}, acquired ` +
        `${input.acquiredAt.toISOString().slice(0, 10)}. Its ${costBasis.toFixed(2)} of value is ` +
        'recorded as a transfer in, so it counts towards what you own and never towards what ' +
        'you earned. No order was created, so no strategy is credited with it.',
    };
  }

  /** Imported positions for a portfolio, newest acquisition first. */
  async listImported(principal: Principal, portfolioId: string) {
    await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.POSITION_READ,
    });
    const rows = await this.db.position.findMany({
      where: { portfolioId, origin: 'IMPORTED' },
      orderBy: { openedAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      symbol: row.symbol,
      status: row.status,
      quantity: row.quantity.toString(),
      averageEntryPrice: row.averageEntryPrice.toString(),
      acquiredAt: row.openedAt.toISOString(),
    }));
  }
}

export type { Prisma };
