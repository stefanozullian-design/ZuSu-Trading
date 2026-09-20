import type { Prisma, PrismaClient } from '@prisma/client';
import { type Decimal, Permission, TradingEnvironment, dec } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import { applyFill } from '../orders/position-book.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';

/**
 * Recording what was done somewhere else.
 *
 * These portfolios are not held here. They are held at a brokerage, and this
 * platform's part is to say what is worth doing and then to keep an honest
 * record of what was actually done — the sell happens over there, and the
 * number gets typed in here afterwards. That inversion sets every rule below.
 *
 *   - **A recorded trade has no order and no execution.** It was not routed by
 *     anything here, so there is no fill to point at. The tax lot's
 *     `executionId` is null, which is the true answer; minting a synthetic
 *     order so the column could be filled would put a fiction in the order
 *     book and credit a strategy with a decision a person made alone.
 *
 *   - **The lot arithmetic is the same arithmetic.** A sale entered by hand
 *     consumes lots first-in-first-out through the same `applyFill` that a
 *     routed fill uses, because a realised gain computed two different ways is
 *     two different numbers and only one of them can be reported.
 *
 *   - **Cash may go negative, and says so.** The real cash sits at the
 *     brokerage; this balance is only as complete as what has been typed in,
 *     and a deposit recorded a week late is the ordinary case rather than a
 *     fault. Refusing the buy would punish the person for the order they
 *     entered things in and would leave the book wrong in a way nothing
 *     reports. So the trade is recorded and the shortfall is stated.
 *
 *   - **A dividend is income; a deposit is not.** Both raise equity, and a
 *     return calculation subtracts external contributions so that nobody's
 *     track record improves by wiring money in. A dividend arrived *because*
 *     of what is held, so subtracting it would erase part of the return it
 *     represents. They are different cash-flow types for that one reason.
 *
 *   - **Selling more than is held is refused, not reversed.** The position
 *     book can turn an oversized sale into a short, and for a routed fill that
 *     is right. Typed in by hand it is almost always a typo or a missing
 *     earlier buy, and silently opening a short position would state that a
 *     borrow exists which nobody arranged.
 */

export type RecordedTradeType = 'BUY' | 'SELL' | 'DIVIDEND' | 'DEPOSIT' | 'WITHDRAWAL';

const SHARE_TYPES = new Set<RecordedTradeType>(['BUY', 'SELL']);

export interface RecordTradeInput {
  portfolioId: string;
  type: RecordedTradeType;
  /** Required for a buy or a sell; optional on a dividend, naming its payer. */
  symbol?: string | null;
  /** Shares, for a buy or a sell. Always positive — the type says the direction. */
  quantity?: string | null;
  /** Price per share actually paid or received, for a buy or a sell. */
  price?: string | null;
  /** Cash amount, for a dividend, deposit or withdrawal. Always positive. */
  amount?: string | null;
  /** Commission and anything else the broker took. Buys and sells only. */
  fees?: string | null;
  /** When it happened at the broker, never when it was typed in. */
  occurredAt: Date;
  note?: string | null;
}

export interface RecordedTradeView {
  id: string;
  portfolioId: string;
  type: RecordedTradeType;
  symbol: string | null;
  quantity: string | null;
  price: string | null;
  /** Signed. Negative means the recorded cash balance went down. */
  cashDelta: string;
  cashBalanceAfter: string;
  /** Realised by this entry alone. Null when nothing was closed. */
  realizedPnl: string | null;
  positionId: string | null;
  cashFlowId: string | null;
  occurredAt: string;
  detail: string;
  /** Things worth knowing that are not reasons to refuse the entry. */
  warnings: string[];
}

export class TradeRecordService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
    private readonly audit: AuditService,
  ) {}

  async record(principal: Principal, input: RecordTradeInput): Promise<RecordedTradeView> {
    const portfolio = await this.access.assertPortfolioAccess(principal, input.portfolioId, {
      permission: Permission.PORTFOLIO_WRITE,
      requireTrade: true,
    });

    if (input.occurredAt.getTime() > Date.now() + 60_000) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The date is in the future. A trade that has not happened yet is a plan, and this ' +
          'records what was done.',
      );
    }

    const view = SHARE_TYPES.has(input.type)
      ? await this.recordShares(principal, portfolio, input)
      : await this.recordCash(principal, portfolio, input);

    await this.audit.record({
      action: 'TRADE_RECORDED',
      actorUserId: principal.id,
      actorType: 'USER',
      // The ledger row, not the position or the cash flow it produced: those
      // are the effect, and the effect is mutable. What was entered is not.
      entityType: 'recordedTrade',
      entityId: view.id,
      portfolioId: portfolio.id,
      environment: portfolio.environment as TradingEnvironment,
      after: {
        type: input.type,
        symbol: view.symbol,
        quantity: view.quantity,
        price: view.price,
        cashDelta: view.cashDelta,
        occurredAt: input.occurredAt.toISOString(),
      },
      metadata: {
        // Stated in the log because it is the thing a reader will later ask
        // about: this entry was typed in, so no order exists to look up.
        recordedByHand: true,
        ...(view.realizedPnl ? { realizedPnl: view.realizedPnl } : {}),
      } as unknown as Record<string, unknown>,
    });

    return view;
  }

  /**
   * What has been entered for a portfolio, newest first.
   *
   * Read straight from the ledger rather than reconstructed from positions and
   * lots, because a reconstruction can only show the entries a later trade has
   * not yet absorbed — which is precisely the ones nobody needs to check.
   */
  async history(
    principal: Principal,
    portfolioId: string,
    options: { symbol?: string; limit?: number } = {},
  ) {
    await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.POSITION_READ,
    });

    const symbol = options.symbol?.trim().toUpperCase();
    const rows = await this.db.recordedTrade.findMany({
      where: { portfolioId, ...(symbol ? { symbol } : {}) },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(options.limit ?? 100, 1), 500),
    });

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      symbol: row.symbol,
      quantity: row.quantity?.toString() ?? null,
      price: row.price?.toString() ?? null,
      cashDelta: row.cashDelta.toString(),
      realizedPnl: row.realizedPnl?.toString() ?? null,
      occurredAt: row.occurredAt.toISOString(),
      note: row.note,
      // Every row in this table was typed in. The field exists so that a
      // future reader of the history endpoint, once routed fills also appear
      // here, does not have to infer it from the absence of an order.
      recordedByHand: true,
    }));
  }

  // -- shares ---------------------------------------------------------------

  private async recordShares(
    principal: Principal,
    portfolio: { id: string; cashBalance: Prisma.Decimal; environment: string },
    input: RecordTradeInput,
  ): Promise<RecordedTradeView> {
    // Contradictions first. Somebody who typed a cash amount into a buy has a
    // different misunderstanding from somebody who left the price blank, and
    // "this entry needs a price" would not correct it.
    rejectField(input.amount, 'amount', input.type, 'the quantity and price say what it was worth');
    const symbol = requireText(input.symbol, 'symbol', input.type).toUpperCase();
    const quantity = requirePositive(input.quantity, 'quantity', 'shares');
    const price = requirePositive(input.price, 'price', 'a price per share');
    const fees = optionalNonNegative(input.fees, 'fees');

    const instrument = await this.db.instrument.findUnique({ where: { symbol } });
    if (!instrument) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${symbol} is not an instrument this platform knows, so it could never be priced, ` +
          'charted or risk-checked. Add the symbol first — the data provider is asked whether ' +
          'it exists, and its history is fetched at the same time.',
      );
    }

    const open = await this.db.position.findFirst({
      where: { portfolioId: portfolio.id, symbol, status: 'OPEN' },
    });

    if (input.type === 'SELL') {
      const held = open ? dec(open.quantity.toString()) : dec(0);
      if (held.lessThanOrEqualTo(0)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This portfolio holds no ${symbol}, so there is nothing to sell. If the shares were ` +
            'bought before this platform was keeping the book, record the purchase first — ' +
            'the sale needs a cost basis to compute a gain against.',
        );
      }
      if (quantity.greaterThan(held)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `You are recording a sale of ${quantity.toString()} ${symbol} but the book shows ` +
            `${held.toString()} held. Recording it would open a short position nobody ` +
            'arranged. Either the quantity is a typo, or a purchase is missing — record the ' +
            'missing buy first and the sale will fit.',
        );
      }
    }

    const gross = price.times(quantity);
    const cashDelta = input.type === 'BUY' ? gross.plus(fees).negated() : gross.minus(fees);
    const cashBefore = dec(portfolio.cashBalance.toString());
    const cashAfter = cashBefore.plus(cashDelta);

    const result = await this.db.$transaction(async (tx) => {
      const fill = await applyFill(tx, {
        portfolioId: portfolio.id,
        symbol,
        side: input.type === 'BUY' ? 'BUY' : 'SELL',
        quantity,
        price,
        fees,
        executedAt: input.occurredAt,
        // No execution exists: nothing routed this.
        executionId: null,
        assetClass: instrument.assetClass,
      });

      if (fees.greaterThan(0)) {
        // Recorded separately as well as on the position, because the
        // performance snapshot sums this table and a fee only on the position
        // would vanish from the report the moment the position closed.
        await tx.fee.create({
          data: {
            portfolioId: portfolio.id,
            type: 'COMMISSION',
            amount: fees.toString(),
            description: `${input.type} ${quantity.toString()} ${symbol}, recorded by hand`,
            incurredAt: input.occurredAt,
          },
        });
      }

      await tx.portfolio.update({
        where: { id: portfolio.id },
        data: { cashBalance: cashAfter.toString() },
      });

      // The entry itself. The position above records what is held now; this
      // records what was done, which no later trade can overwrite.
      const entry = await tx.recordedTrade.create({
        data: {
          portfolioId: portfolio.id,
          type: input.type === 'BUY' ? 'BUY' : 'SELL',
          symbol,
          quantity: quantity.toString(),
          price: price.toString(),
          fees: fees.toString(),
          cashDelta: cashDelta.toString(),
          ...(input.type === 'SELL' ? { realizedPnl: fill.realizedPnl.toString() } : {}),
          positionId: fill.positionId,
          occurredAt: input.occurredAt,
          note: input.note?.trim() || null,
          recordedById: principal.id,
        },
      });

      return { fill, entry };
    });

    const { fill, entry } = result;
    const warnings: string[] = [];
    if (cashAfter.isNegative()) warnings.push(negativeCashWarning(cashAfter));
    if (input.type === 'SELL' && fill.closed) {
      warnings.push(`That closed the ${symbol} position. Its lots and its gain are kept.`);
    }

    const verb = input.type === 'BUY' ? 'Bought' : 'Sold';
    const realized = input.type === 'SELL' ? fill.realizedPnl : null;

    return {
      id: entry.id,
      portfolioId: portfolio.id,
      type: input.type,
      symbol,
      quantity: quantity.toString(),
      price: price.toString(),
      cashDelta: cashDelta.toString(),
      cashBalanceAfter: cashAfter.toString(),
      realizedPnl: realized ? realized.toString() : null,
      positionId: fill.positionId,
      cashFlowId: null,
      occurredAt: input.occurredAt.toISOString(),
      detail:
        `${verb} ${quantity.toString()} ${symbol} at ${price.toFixed(4)}` +
        (fees.greaterThan(0) ? ` plus ${fees.toFixed(2)} of fees` : '') +
        `. Recorded cash is now ${cashAfter.toFixed(2)}.` +
        (realized
          ? ` The lots this consumed realised ${realized.toFixed(2)}, computed first-in-first-out.`
          : '') +
        ' No order was created, so no strategy is credited with it.',
      warnings,
    };
  }

  // -- cash -----------------------------------------------------------------

  private async recordCash(
    principal: Principal,
    portfolio: { id: string; cashBalance: Prisma.Decimal; environment: string },
    input: RecordTradeInput,
  ): Promise<RecordedTradeView> {
    rejectField(input.quantity, 'quantity', input.type, 'this moves cash, not shares');
    rejectField(input.price, 'price', input.type, 'this moves cash, not shares');
    rejectField(input.fees, 'fees', input.type, 'record the net amount that actually arrived');
    const amount = requirePositive(input.amount, 'amount', 'an amount of cash');

    // A dividend may name what paid it; a deposit and a withdrawal may not,
    // because no holding produced them.
    const symbol =
      input.type === 'DIVIDEND' && input.symbol?.trim() ? input.symbol.trim().toUpperCase() : null;
    if (symbol === null && input.symbol?.trim() && input.type !== 'DIVIDEND') {
      throw new AppError(
        'VALIDATION_FAILED',
        `A ${input.type.toLowerCase()} is not tied to a holding, so it carries no symbol.`,
      );
    }

    const warnings: string[] = [];
    if (symbol) {
      const held = await this.db.position.findFirst({
        where: { portfolioId: portfolio.id, symbol, status: 'OPEN' },
        select: { id: true },
      });
      if (!held) {
        // Not an error: a dividend on an ex-date before a sale is ordinary.
        warnings.push(
          `This portfolio holds no ${symbol} today. That is normal for a dividend paid on ` +
            'shares since sold, and worth a second look otherwise.',
        );
      }
    }

    const cashDelta = input.type === 'WITHDRAWAL' ? amount.negated() : amount;
    const cashBefore = dec(portfolio.cashBalance.toString());
    const cashAfter = cashBefore.plus(cashDelta);

    const flow = await this.db.$transaction(async (tx) => {
      const created = await tx.cashFlow.create({
        data: {
          portfolioId: portfolio.id,
          type: input.type as 'DIVIDEND' | 'DEPOSIT' | 'WITHDRAWAL',
          // Stored signed, so a sum over the column is the net movement and
          // cannot be got wrong by a reader who forgets the type.
          amount: cashDelta.toString(),
          occurredAt: input.occurredAt,
          ...(symbol ? { reference: symbol } : {}),
          note: input.note?.trim() || null,
        },
      });
      await tx.portfolio.update({
        where: { id: portfolio.id },
        data: { cashBalance: cashAfter.toString() },
      });
      const entry = await tx.recordedTrade.create({
        data: {
          portfolioId: portfolio.id,
          type: input.type as 'DIVIDEND' | 'DEPOSIT' | 'WITHDRAWAL',
          symbol,
          cashDelta: cashDelta.toString(),
          cashFlowId: created.id,
          occurredAt: input.occurredAt,
          note: input.note?.trim() || null,
          recordedById: principal.id,
        },
      });
      return { created, entry };
    });

    if (cashAfter.isNegative()) warnings.push(negativeCashWarning(cashAfter));

    return {
      id: flow.entry.id,
      portfolioId: portfolio.id,
      type: input.type,
      symbol,
      quantity: null,
      price: null,
      cashDelta: cashDelta.toString(),
      cashBalanceAfter: cashAfter.toString(),
      realizedPnl: null,
      positionId: null,
      cashFlowId: flow.created.id,
      occurredAt: input.occurredAt.toISOString(),
      detail: `${describeCash(input.type, amount, symbol)} Recorded cash is now ${cashAfter.toFixed(2)}.`,
      warnings,
    };
  }
}

function describeCash(type: RecordedTradeType, amount: Decimal, symbol: string | null): string {
  if (type === 'DIVIDEND') {
    return (
      `${amount.toFixed(2)} of dividend${symbol ? ` from ${symbol}` : ''} recorded. It counts ` +
      'towards what you earned, not towards what you paid in.'
    );
  }
  if (type === 'DEPOSIT') {
    return (
      `${amount.toFixed(2)} paid in. It raises what you own and never what you earned — the ` +
      'return calculation subtracts it.'
    );
  }
  return (
    `${amount.toFixed(2)} taken out. It lowers what you own and never counts as a loss — the ` +
    'return calculation adds it back.'
  );
}

function negativeCashWarning(cashAfter: Decimal): string {
  return (
    `Recorded cash is now ${cashAfter.toFixed(2)}, which is negative. The real cash is at your ` +
    'broker; this balance only knows what has been typed in, so this usually means a deposit ' +
    'or a sale has not been recorded yet. The entry was kept either way.'
  );
}

function requireText(value: string | null | undefined, field: string, type: string): string {
  const text = value?.trim();
  if (!text) {
    throw new AppError('VALIDATION_FAILED', `A ${type.toLowerCase()} needs a ${field}.`);
  }
  return text;
}

function requirePositive(value: string | null | undefined, field: string, noun: string): Decimal {
  if (value === null || value === undefined || value.trim() === '') {
    throw new AppError('VALIDATION_FAILED', `This entry needs ${noun}.`);
  }
  const parsed = dec(value);
  if (!parsed.isFinite() || parsed.lessThanOrEqualTo(0)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `The ${field} must be a positive number. The type of the entry says which way it goes, ` +
        'so a negative one would say it twice and disagree with itself.',
    );
  }
  return parsed;
}

function optionalNonNegative(value: string | null | undefined, field: string): Decimal {
  if (value === null || value === undefined || value.trim() === '') return dec(0);
  const parsed = dec(value);
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new AppError('VALIDATION_FAILED', `The ${field} cannot be negative.`);
  }
  return parsed;
}

function rejectField(
  value: string | null | undefined,
  field: string,
  type: string,
  because: string,
): void {
  if (value !== null && value !== undefined && value.trim() !== '') {
    throw new AppError(
      'VALIDATION_FAILED',
      `A ${type.toLowerCase()} carries no ${field} — ${because}.`,
    );
  }
}
