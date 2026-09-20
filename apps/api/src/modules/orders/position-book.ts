import type { Prisma } from '@prisma/client';
import { Decimal, dec } from '@zusu/shared';

/**
 * Positions and tax lots (§38, §40).
 *
 * Every fill is applied here, and the rules are the ones a tax authority and a
 * reconciliation both need:
 *
 *   1. **A lot is never averaged away.** Each opening fill creates a lot with
 *      its own cost basis and its own opening date, because "what did we pay
 *      for these particular shares, and when" is a question an average price
 *      cannot answer — and it decides the holding period.
 *
 *   2. **Closing consumes lots oldest-first.** FIFO is the default a US
 *      brokerage applies unless told otherwise, so it is what this models. A
 *      specific-lot method would be a per-sale choice, and inventing one
 *      silently would misstate the gain.
 *
 *   3. **A closed position is history, not a deletion.** Quantity reaching
 *      zero closes the position and keeps it, with its realised profit and its
 *      lots. The partial unique index in the schema allows exactly one OPEN
 *      position per symbol, so a new trade opens a new row rather than
 *      resurrecting an old one.
 *
 *   4. **A reversal is two events.** Selling more than is held closes the
 *      position and opens a new one in the other direction; it is never one
 *      position that changed sign, because the cost basis of the new exposure
 *      is the fill that opened it.
 */

export interface FillInput {
  portfolioId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: Decimal;
  price: Decimal;
  fees: Decimal;
  executedAt: Date;
  /**
   * The fill this lot came from, when one exists. A trade recorded by hand —
   * done at a real brokerage and typed in afterwards — has no execution to
   * point at, and inventing a synthetic order so the column could be filled
   * would put a fiction in the order book to satisfy a foreign key. The lot
   * carries null instead, which is the true answer to "which fill was this".
   */
  executionId?: string | null;
  assetClass?: string;
  /** Recorded on the position when it opens, for the exit plumbing to read. */
  stopPrice?: Decimal | null;
  targetPrice?: Decimal | null;
}

export interface FillOutcome {
  positionId: string;
  /** Signed quantity after the fill. Zero means the position closed. */
  quantityAfter: Decimal;
  /** Profit realised by this fill alone, net of nothing — fees are separate. */
  realizedPnl: Decimal;
  /** True when this fill created the position. */
  opened: boolean;
  closed: boolean;
  /** Lots this fill consumed, with the gain attributed to each. */
  lotsClosed: { lotId: string; quantity: string; realizedGain: string }[];
}

/**
 * Applies one fill inside a transaction.
 *
 * A transaction because a fill touches the position, its lots and the
 * portfolio's cash: a crash between those writes would leave an account whose
 * cash and shares disagree, which reconciliation would report as a broker
 * discrepancy that never happened.
 */
export async function applyFill(
  tx: Prisma.TransactionClient,
  input: FillInput,
): Promise<FillOutcome> {
  const signed = input.side === 'BUY' ? input.quantity : input.quantity.negated();

  const existing = await tx.position.findFirst({
    where: { portfolioId: input.portfolioId, symbol: input.symbol, status: 'OPEN' },
  });

  if (!existing) {
    const position = await openPosition(tx, input, signed);
    return {
      positionId: position.id,
      quantityAfter: signed,
      realizedPnl: dec(0),
      opened: true,
      closed: false,
      lotsClosed: [],
    };
  }

  const held = dec(existing.quantity.toString());
  const addingToPosition = held.isPositive() === signed.isPositive();

  if (addingToPosition) {
    const lot = await tx.positionLot.create({
      data: {
        positionId: existing.id,
        executionId: input.executionId ?? null,
        quantity: input.quantity.toString(),
        remainingQty: input.quantity.toString(),
        costBasis: input.price.times(input.quantity).toString(),
        openedAt: input.executedAt,
      },
    });
    void lot;

    const quantityAfter = held.plus(signed);
    const previousCost = dec(existing.averageEntryPrice.toString()).times(held.abs());
    const addedCost = input.price.times(input.quantity);
    await tx.position.update({
      where: { id: existing.id },
      data: {
        quantity: quantityAfter.toString(),
        averageEntryPrice: previousCost.plus(addedCost).div(quantityAfter.abs()).toString(),
        feesTotal: dec(existing.feesTotal.toString()).plus(input.fees).toString(),
      },
    });

    return {
      positionId: existing.id,
      quantityAfter,
      realizedPnl: dec(0),
      opened: false,
      closed: false,
      lotsClosed: [],
    };
  }

  // Closing, in whole or in part. Anything beyond the held quantity is a new
  // position in the other direction, so it is handled as a second event.
  const closingQty = Decimal.min(held.abs(), input.quantity);
  const consumed = await consumeLots(tx, {
    positionId: existing.id,
    quantity: closingQty,
    price: input.price,
    at: input.executedAt,
    isLong: held.isPositive(),
  });

  const quantityAfterClose = held.plus(held.isPositive() ? closingQty.negated() : closingQty);
  const realized = dec(existing.realizedPnl.toString()).plus(consumed.realizedPnl);

  await tx.position.update({
    where: { id: existing.id },
    data: {
      quantity: quantityAfterClose.toString(),
      realizedPnl: realized.toString(),
      feesTotal: dec(existing.feesTotal.toString()).plus(input.fees).toString(),
      ...(quantityAfterClose.isZero()
        ? { status: 'CLOSED', closedAt: input.executedAt, unrealizedPnl: '0' }
        : {}),
    },
  });

  const remainder = input.quantity.minus(closingQty);
  if (remainder.greaterThan(0)) {
    // A reversal: the old position is closed above, and this opens a new one
    // whose cost basis is this fill.
    const reversed = await openPosition(
      tx,
      { ...input, quantity: remainder },
      input.side === 'BUY' ? remainder : remainder.negated(),
    );
    return {
      positionId: reversed.id,
      quantityAfter: input.side === 'BUY' ? remainder : remainder.negated(),
      realizedPnl: consumed.realizedPnl,
      opened: true,
      closed: true,
      lotsClosed: consumed.lotsClosed,
    };
  }

  return {
    positionId: existing.id,
    quantityAfter: quantityAfterClose,
    realizedPnl: consumed.realizedPnl,
    opened: false,
    closed: quantityAfterClose.isZero(),
    lotsClosed: consumed.lotsClosed,
  };
}

async function openPosition(
  tx: Prisma.TransactionClient,
  input: FillInput,
  signed: Decimal,
): Promise<{ id: string }> {
  const position = await tx.position.create({
    data: {
      portfolioId: input.portfolioId,
      symbol: input.symbol,
      assetClass: (input.assetClass ?? 'EQUITY') as 'EQUITY',
      status: 'OPEN',
      quantity: signed.toString(),
      averageEntryPrice: input.price.toString(),
      markPrice: input.price.toString(),
      feesTotal: input.fees.toString(),
      openedAt: input.executedAt,
      ...(input.stopPrice ? { stopPrice: input.stopPrice.toString() } : {}),
      ...(input.targetPrice ? { targetPrice: input.targetPrice.toString() } : {}),
    },
  });

  await tx.positionLot.create({
    data: {
      positionId: position.id,
      executionId: input.executionId ?? null,
      quantity: input.quantity.toString(),
      remainingQty: input.quantity.toString(),
      costBasis: input.price.times(input.quantity).toString(),
      openedAt: input.executedAt,
    },
  });

  return position;
}

/** Consumes open lots oldest-first, attributing the gain to each. */
async function consumeLots(
  tx: Prisma.TransactionClient,
  args: {
    positionId: string;
    quantity: Decimal;
    price: Decimal;
    at: Date;
    isLong: boolean;
  },
): Promise<{
  realizedPnl: Decimal;
  lotsClosed: { lotId: string; quantity: string; realizedGain: string }[];
}> {
  const lots = await tx.positionLot.findMany({
    where: { positionId: args.positionId, closedAt: null },
    orderBy: { openedAt: 'asc' },
  });

  let remaining = args.quantity;
  let realizedPnl = dec(0);
  const lotsClosed: { lotId: string; quantity: string; realizedGain: string }[] = [];

  for (const lot of lots) {
    if (remaining.lessThanOrEqualTo(0)) break;

    const available = dec(lot.remainingQty.toString());
    if (available.lessThanOrEqualTo(0)) continue;

    const take = Decimal.min(available, remaining);
    const lotQuantity = dec(lot.quantity.toString());
    // Per-share basis from this lot's own cost, not the position's average.
    const perShareBasis = dec(lot.costBasis.toString()).div(lotQuantity);
    const gainPerShare = args.isLong
      ? args.price.minus(perShareBasis)
      : perShareBasis.minus(args.price);
    const gain = gainPerShare.times(take);

    const leftover = available.minus(take);
    await tx.positionLot.update({
      where: { id: lot.id },
      data: {
        remainingQty: leftover.toString(),
        realizedGain: dec(lot.realizedGain.toString()).plus(gain).toString(),
        ...(leftover.isZero() ? { closedAt: args.at } : {}),
      },
    });

    realizedPnl = realizedPnl.plus(gain);
    remaining = remaining.minus(take);
    lotsClosed.push({ lotId: lot.id, quantity: take.toString(), realizedGain: gain.toString() });
  }

  if (remaining.greaterThan(0)) {
    // The position said it held more than its lots account for. That is a
    // bookkeeping fault, not a trade to wave through.
    throw new Error(
      `Position ${args.positionId} has ${remaining.toString()} shares to close with no lot ` +
        'to attribute them to. The lot ledger and the position quantity disagree.',
    );
  }

  return { realizedPnl, lotsClosed };
}

/** The open lots of a position, oldest first, for a tax-lot view. */
export async function openLots(
  tx: Prisma.TransactionClient,
  positionId: string,
): Promise<
  { id: string; quantity: string; remainingQty: string; costBasis: string; openedAt: Date }[]
> {
  const lots = await tx.positionLot.findMany({
    where: { positionId, closedAt: null },
    orderBy: { openedAt: 'asc' },
  });
  return lots.map((lot) => ({
    id: lot.id,
    quantity: lot.quantity.toString(),
    remainingQty: lot.remainingQty.toString(),
    costBasis: lot.costBasis.toString(),
    openedAt: lot.openedAt,
  }));
}
