import Decimal from 'decimal.js';
import { dec } from '@zusu/shared';
import { evaluateRule } from '../strategies/rule-tree.js';
import type { RiskSettings, StrategyDefinition } from '../strategies/strategy.service.js';
import type { IndicatorSeries } from '../market-data/indicator.service.js';
import type { ProviderCandle } from '../market-data/types.js';

/**
 * The backtest engine (§29).
 *
 * Deterministic and pure: the same inputs produce the same trades, every time.
 * Nothing here reads a clock, a database or a random number generator, which is
 * what makes a result reproducible — and a backtest nobody can reproduce is a
 * backtest nobody can check.
 *
 * Five rules do most of the work, and each exists because its opposite is the
 * standard way a backtest lies:
 *
 *   1. **A decision at bar N is filled at the open of bar N+1.** The rule is
 *      evaluated on a closed bar, which means the close is known — so filling
 *      at that same close would be trading on information that arrived at the
 *      moment of the decision. Every entry and every rule-driven exit waits for
 *      the next bar's open. (A stop or target is different: it is a resting
 *      price, and the bar that reaches it fills it.)
 *
 *   2. **Costs are never optional.** A half-spread and a slippage fraction move
 *      every fill against the position, and commission is charged on both
 *      sides. `grossPnl` is reported separately from `netPnl` so the difference
 *      is visible rather than flattering.
 *
 *   3. **A gap fills at the open, not at the stop.** If a bar opens through the
 *      stop, the fill is the open — which is worse. Pretending the stop held is
 *      the single most common way a backtest overstates a strategy.
 *
 *   4. **An ambiguous bar resolves against the position.** When one bar's range
 *      contains both the stop and the target, five-minute candles cannot say
 *      which came first. The stop is taken, and the count of such bars is
 *      reported: a result resting on many of them is a result to distrust.
 *
 *   5. **Unknown is not a signal.** A bar whose indicators have not warmed up
 *      produces no trade and is counted, so "the strategy did nothing" can be
 *      told apart from "the strategy was never asked".
 */

export interface BacktestCosts {
  /** Flat commission charged on each side of a trade. */
  commissionPerTrade: Decimal;
  /** Additional commission per share, on each side. */
  commissionPerShare: Decimal;
  /** Half the bid/ask spread, as a fraction of price. Applied to every fill. */
  spreadFraction: Decimal;
  /** Adverse price move on every fill, as a fraction of price. */
  slippageFraction: Decimal;
}

export const DEFAULT_COSTS: BacktestCosts = {
  commissionPerTrade: dec('1'),
  commissionPerShare: dec('0'),
  // A penny spread on a $100 stock is 0.0001 of price; half of it is 0.00005.
  spreadFraction: dec('0.00005'),
  slippageFraction: dec('0.0002'),
};

export interface SymbolSeries {
  symbol: string;
  candles: ProviderCandle[];
  series: IndicatorSeries;
}

export interface BacktestInput {
  definition: StrategyDefinition;
  riskSettings: RiskSettings;
  initialCapital: Decimal;
  costs: BacktestCosts;
  symbols: SymbolSeries[];
}

export type ExitReason = 'STOP' | 'TARGET' | 'RULE' | 'END_OF_DATA';

export interface BacktestTrade {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: Decimal;
  entryTime: Date;
  entryPrice: Decimal;
  exitTime: Date;
  exitPrice: Decimal;
  grossPnl: Decimal;
  fees: Decimal;
  slippage: Decimal;
  netPnl: Decimal;
  /** Net profit in units of the risk taken. Null without a stop to measure. */
  rMultiple: Decimal | null;
  /** Worst and best unrealised excursion while the position was open. */
  maeAmount: Decimal;
  mfeAmount: Decimal;
  exitReason: ExitReason;
  barsHeld: number;
  /** True when one bar contained both the stop and the target. */
  exitWasAmbiguous: boolean;
}

export interface EquityPoint {
  at: Date;
  /** Cash plus the mark-to-market value of open positions. */
  equity: Decimal;
  cash: Decimal;
  openPositions: number;
}

export interface BacktestSkip {
  at: Date;
  symbol: string;
  reason: string;
}

export interface BacktestRun {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  /** Entry decisions the engine could not act on, each with why. */
  skips: BacktestSkip[];
  counters: {
    barsEvaluated: number;
    unknownVerdicts: number;
    entrySignals: number;
    ambiguousExitBars: number;
    gapThroughStop: number;
  };
}

interface OpenPosition {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: Decimal;
  entryTime: Date;
  entryPrice: Decimal;
  entryFees: Decimal;
  entrySlippage: Decimal;
  stopPrice: Decimal | null;
  targetPrice: Decimal | null;
  /** The stop distance at entry, which is what an R multiple is measured in. */
  riskPerShare: Decimal | null;
  mae: Decimal;
  mfe: Decimal;
  barsHeld: number;
  /** Set when the exit rule fired; the fill waits for the next bar's open. */
  exitQueued: boolean;
}

/** A bar of one symbol, with the index it sits at in that symbol's arrays. */
interface BarRef {
  symbol: string;
  index: number;
}

export function runBacktest(input: BacktestInput): BacktestRun {
  const { definition, riskSettings, costs } = input;
  const long = definition.entry.direction === 'LONG';

  const bySymbol = new Map<string, SymbolSeries>();
  /** bar open time (ms) → the symbols with a bar at that instant */
  const timeline = new Map<number, BarRef[]>();

  for (const entry of input.symbols) {
    bySymbol.set(entry.symbol, entry);
    entry.candles.forEach((candle, index) => {
      const key = candle.openTime.getTime();
      const refs = timeline.get(key);
      if (refs) refs.push({ symbol: entry.symbol, index });
      else timeline.set(key, [{ symbol: entry.symbol, index }]);
    });
  }

  const instants = [...timeline.keys()].sort((a, b) => a - b);

  let cash = input.initialCapital;
  const open = new Map<string, OpenPosition>();
  /** Symbols with an entry decided on a closed bar, awaiting the next open. */
  const pendingEntries = new Set<string>();
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const skips: BacktestSkip[] = [];
  const counters = {
    barsEvaluated: 0,
    unknownVerdicts: 0,
    entrySignals: 0,
    ambiguousExitBars: 0,
    gapThroughStop: 0,
  };
  const lastClose = new Map<string, Decimal>();

  for (const instant of instants) {
    const at = new Date(instant);
    const refs = timeline.get(instant) ?? [];

    for (const ref of refs) {
      const entry = bySymbol.get(ref.symbol);
      if (!entry) continue;
      const candle = entry.candles[ref.index];
      if (!candle) continue;

      // --- 1. Fills that were decided on the previous bar ------------------
      const position = open.get(ref.symbol);

      if (position?.exitQueued) {
        closePosition({
          position,
          price: candle.open,
          at: candle.openTime,
          reason: 'RULE',
          ambiguous: false,
        });
        open.delete(ref.symbol);
      }

      // --- 2. Entries decided on the previous bar, filled at this open -----
      if (pendingEntries.has(ref.symbol) && !open.has(ref.symbol)) {
        pendingEntries.delete(ref.symbol);
        openPosition(ref.symbol, entry, ref.index, candle);
      }

      // --- 3. A resting stop or target, checked against this bar's range ---
      // Including the bar a position opened on: a stop placed at the open is
      // live for the rest of that bar, and pretending otherwise would let
      // every position survive its first bar for free.
      const resting = open.get(ref.symbol);
      if (resting) {
        const exit = resolveIntrabarExit(resting, candle);
        if (exit) {
          if (exit.gapped) counters.gapThroughStop += 1;
          if (exit.ambiguous) counters.ambiguousExitBars += 1;
          closePosition({
            position: resting,
            price: exit.price,
            at: candle.openTime,
            reason: exit.reason,
            ambiguous: exit.ambiguous,
          });
          open.delete(ref.symbol);
        }
      }

      // --- 4. Update an open position's excursions and bar count -----------
      const held = open.get(ref.symbol);
      if (held) {
        held.barsHeld += 1;
        const favourable = held.direction === 'LONG' ? candle.high : candle.low;
        const adverse = held.direction === 'LONG' ? candle.low : candle.high;
        const mfe = perShareGain(held, favourable).times(held.quantity);
        const mae = perShareGain(held, adverse).times(held.quantity);
        if (mfe.greaterThan(held.mfe)) held.mfe = mfe;
        if (mae.lessThan(held.mae)) held.mae = mae;
      }

      lastClose.set(ref.symbol, candle.close);

      // --- 5. Decide on this closed bar, to be acted on at the next open ---
      decide(ref.symbol, entry, ref.index, at);
    }

    equityCurve.push({
      at,
      equity: markToMarket(),
      cash,
      openPositions: open.size,
    });
  }

  // Anything still open at the end is closed at the last close, and labelled
  // as such: a backtest that silently drops open positions reports only the
  // trades that finished, which flatters a strategy that holds its losers.
  for (const [symbol, position] of open) {
    const price = lastClose.get(symbol);
    const entry = bySymbol.get(symbol);
    const lastCandle = entry?.candles[entry.candles.length - 1];
    if (!price || !lastCandle) continue;
    closePosition({
      position,
      price,
      at: lastCandle.openTime,
      reason: 'END_OF_DATA',
      ambiguous: false,
    });
  }
  open.clear();

  return { trades, equityCurve, skips, counters };

  // --------------------------------------------------------------------------

  function decide(symbol: string, entry: SymbolSeries, index: number, at: Date): void {
    const position = open.get(symbol);

    if (position && definition.exit) {
      const verdict = evaluateRule(definition.exit.when, entry.series, index);
      if (verdict.shouldFire) position.exitQueued = true;
      return;
    }
    if (position) return;
    if (pendingEntries.has(symbol)) return;

    // Warm-up: a rule may not be asked before it has the history it declared
    // it needs. Asking earlier would answer from partially-formed indicators.
    if (index + 1 < riskSettings.minBars) return;

    counters.barsEvaluated += 1;
    const verdict = evaluateRule(definition.entry.when, entry.series, index);

    if (verdict.satisfied === null) {
      counters.unknownVerdicts += 1;
      return;
    }
    if (!verdict.shouldFire) return;

    counters.entrySignals += 1;

    if (open.size >= riskSettings.maxConcurrentPositions) {
      skips.push({
        at,
        symbol,
        reason: `already holding ${String(open.size)} positions, the configured maximum`,
      });
      return;
    }

    pendingEntries.add(symbol);
  }

  function openPosition(
    symbol: string,
    entry: SymbolSeries,
    index: number,
    candle: ProviderCandle,
  ): void {
    // The fill price is the open, moved against the position by the spread and
    // slippage. Sizing uses that price, not the clean one.
    if (open.size >= riskSettings.maxConcurrentPositions) {
      // Several symbols can each queue an entry on the same bar, every one of
      // them seeing room that the others are about to take. The limit is a
      // limit on positions held, so it is enforced here as well as at the
      // decision.
      skips.push({
        at: candle.openTime,
        symbol,
        reason: `already holding ${String(open.size)} positions, the configured maximum`,
      });
      return;
    }

    const fillPrice = adverseFill(candle.open, long ? 'BUY' : 'SELL');
    if (fillPrice.lessThanOrEqualTo(0)) return;

    const budget = Decimal.min(dec(riskSettings.maxNotionalPerTrade), cash);
    const quantity = budget.div(fillPrice).floor();

    if (quantity.lessThanOrEqualTo(0)) {
      skips.push({
        at: candle.openTime,
        symbol,
        reason:
          `a single share costs ${fillPrice.toFixed(2)}, more than the ` +
          `${budget.toFixed(2)} available under this version's limits`,
      });
      return;
    }

    const notional = fillPrice.times(quantity);
    const fees = costs.commissionPerTrade.plus(costs.commissionPerShare.times(quantity));
    const slippage = fillPrice.minus(candle.open).abs().times(quantity);

    // The stop and target are derived from the *fill*, not from the signal
    // bar's close, so the risk measured is the risk actually taken.
    const atr = entry.series.atr14[index] ?? null;
    const stopPrice = stopFor(fillPrice, atr);
    const riskPerShare = stopPrice ? fillPrice.minus(stopPrice).abs() : null;
    const targetPrice = targetFor(fillPrice, atr, riskPerShare);

    cash = cash.minus(long ? notional : notional.negated()).minus(fees);

    open.set(symbol, {
      symbol,
      direction: long ? 'LONG' : 'SHORT',
      quantity,
      entryTime: candle.openTime,
      entryPrice: fillPrice,
      entryFees: fees,
      entrySlippage: slippage,
      stopPrice,
      targetPrice,
      riskPerShare,
      mae: dec(0),
      mfe: dec(0),
      barsHeld: 0,
      exitQueued: false,
    });
  }

  function closePosition(args: {
    position: OpenPosition;
    price: Decimal;
    at: Date;
    reason: ExitReason;
    ambiguous: boolean;
  }): void {
    const { position, reason, ambiguous } = args;
    // A stop or target fills at its own price; the spread and slippage still
    // apply, because a resting order is not free either.
    const fillPrice = adverseFill(args.price, position.direction === 'LONG' ? 'SELL' : 'BUY');
    const notional = fillPrice.times(position.quantity);
    const exitFees = costs.commissionPerTrade.plus(
      costs.commissionPerShare.times(position.quantity),
    );
    const exitSlippage = fillPrice.minus(args.price).abs().times(position.quantity);

    const grossPnl = perShareGain(position, fillPrice).times(position.quantity);
    const fees = position.entryFees.plus(exitFees);
    const slippage = position.entrySlippage.plus(exitSlippage);
    const netPnl = grossPnl.minus(fees).minus(slippage);

    cash = cash.plus(position.direction === 'LONG' ? notional : notional.negated()).minus(exitFees);

    trades.push({
      symbol: position.symbol,
      direction: position.direction,
      quantity: position.quantity,
      entryTime: position.entryTime,
      entryPrice: position.entryPrice,
      exitTime: args.at,
      exitPrice: fillPrice,
      grossPnl,
      fees,
      slippage,
      netPnl,
      rMultiple:
        position.riskPerShare && position.riskPerShare.greaterThan(0)
          ? netPnl.div(position.riskPerShare.times(position.quantity))
          : null,
      maeAmount: position.mae,
      mfeAmount: position.mfe,
      exitReason: reason,
      barsHeld: position.barsHeld,
      exitWasAmbiguous: ambiguous,
    });
  }

  /**
   * Which of the stop and the target this bar reached.
   *
   * A bar is a summary, not a path: when both prices sit inside its range,
   * nothing in the data says which came first. The stop wins, and the caller
   * counts it.
   */
  function resolveIntrabarExit(
    position: OpenPosition,
    candle: ProviderCandle,
  ): { price: Decimal; reason: ExitReason; ambiguous: boolean; gapped: boolean } | null {
    const isLong = position.direction === 'LONG';
    const stop = position.stopPrice;
    const target = position.targetPrice;

    const stopHit = stop
      ? isLong
        ? candle.low.lessThanOrEqualTo(stop)
        : candle.high.greaterThanOrEqualTo(stop)
      : false;
    const targetHit = target
      ? isLong
        ? candle.high.greaterThanOrEqualTo(target)
        : candle.low.lessThanOrEqualTo(target)
      : false;

    if (stopHit && stop) {
      // A bar that opened through the stop fills at the open. Claiming the
      // stop price would be inventing liquidity that was never there.
      const gapped = isLong ? candle.open.lessThan(stop) : candle.open.greaterThan(stop);
      return {
        price: gapped ? candle.open : stop,
        reason: 'STOP',
        ambiguous: targetHit,
        gapped,
      };
    }
    if (targetHit && target) {
      const gapped = isLong ? candle.open.greaterThan(target) : candle.open.lessThan(target);
      return {
        price: gapped ? candle.open : target,
        reason: 'TARGET',
        ambiguous: false,
        gapped,
      };
    }
    return null;
  }

  function stopFor(fillPrice: Decimal, atr: Decimal | null): Decimal | null {
    const stop = definition.stop;
    if (!stop) return null;

    if (stop.kind === 'PERCENT') {
      const move = fillPrice.times(dec(stop.value)).div(100);
      return long ? fillPrice.minus(move) : fillPrice.plus(move);
    }
    // An ATR stop with no ATR is not a stop. Null rather than a fabricated one.
    if (!atr) return null;
    const move = atr.times(dec(stop.value));
    return long ? fillPrice.minus(move) : fillPrice.plus(move);
  }

  function targetFor(
    fillPrice: Decimal,
    atr: Decimal | null,
    riskPerShare: Decimal | null,
  ): Decimal | null {
    const target = definition.target;
    if (!target) return null;
    const multiplier = dec(target.value);

    if (target.kind === 'PERCENT') {
      const move = fillPrice.times(multiplier).div(100);
      return long ? fillPrice.plus(move) : fillPrice.minus(move);
    }
    if (target.kind === 'ATR') {
      if (!atr) return null;
      const move = atr.times(multiplier);
      return long ? fillPrice.plus(move) : fillPrice.minus(move);
    }
    // RISK_MULTIPLE is measured against the stop distance, so without a stop
    // there is nothing to multiply.
    if (!riskPerShare) return null;
    const move = riskPerShare.times(multiplier);
    return long ? fillPrice.plus(move) : fillPrice.minus(move);
  }

  function adverseFill(price: Decimal, side: 'BUY' | 'SELL'): Decimal {
    const drag = costs.spreadFraction.plus(costs.slippageFraction);
    return side === 'BUY' ? price.times(dec(1).plus(drag)) : price.times(dec(1).minus(drag));
  }

  function perShareGain(position: OpenPosition, price: Decimal): Decimal {
    return position.direction === 'LONG'
      ? price.minus(position.entryPrice)
      : position.entryPrice.minus(price);
  }

  function markToMarket(): Decimal {
    let equity = cash;
    for (const position of open.values()) {
      const price = lastClose.get(position.symbol);
      if (!price) continue;
      const notional = price.times(position.quantity);
      // A short's liability grows as price rises, which is why it subtracts.
      equity = equity.plus(position.direction === 'LONG' ? notional : notional.negated());
    }
    return equity;
  }
}
