import { BrokerError } from '../types.js';

/**
 * The operations the live adapter needs from Robinhood.
 *
 * An interface rather than direct calls, for the same reason the market-data
 * adapter has one: it is the seam a fake transport plugs into, and every test
 * in this folder runs against that fake. This deployment has no Robinhood
 * credentials, so nothing here has spoken to the live API — which is stated
 * rather than discovered later by somebody assuming it was tested.
 *
 * The shapes mirror the published contract, including the parts this platform
 * would rather were different: quantities and prices are strings (good),
 * `state` is Robinhood's vocabulary rather than ours (translated in the
 * adapter), and an order carries `placed_agent` so reconciliation can tell
 * this platform's orders from a person's.
 */

export interface RobinhoodAccount {
  account_number: string;
  /** The broker's own record of consent for automated placement. */
  agentic_allowed: boolean;
  option_level: string | null;
  buying_power: string;
  cash: string;
  equity: string;
  type: string;
}

export interface RobinhoodExecution {
  id?: string;
  price: string;
  quantity: string;
  timestamp: string;
}

export interface RobinhoodOrder {
  id: string;
  ref_id: string | null;
  state: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  time_in_force: string;
  quantity: string;
  cumulative_quantity: string;
  average_price: string | null;
  price: string | null;
  stop_price: string | null;
  fees: string | null;
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
  /** 'user', 'agentic', 'recurring', … */
  placed_agent: string | null;
  /** Present when the API exposes per-fill detail; see contract.ts. */
  executions?: RobinhoodExecution[];
}

export interface RobinhoodPosition {
  symbol: string;
  quantity: string;
  average_buy_price: string;
  market_value: string | null;
}

export interface RobinhoodQuote {
  symbol: string;
  last_trade_price: string;
  bid_price: string;
  ask_price: string;
  bid_size: string;
  ask_size: string;
  volume: string;
  updated_at: string;
}

export interface PlaceEquityOrderRequest {
  account_number: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  time_in_force: string;
  market_hours: string;
  quantity: string;
  price?: string;
  stop_price?: string;
  /** The idempotency key. Re-sent verbatim on a retry. */
  ref_id: string;
  tax_lots?: { open_lot_id: string; quantity: string }[];
}

export interface OptionLegRequest {
  option_id: string;
  side: 'buy' | 'sell';
  position_effect: 'open' | 'close';
  ratio_quantity: number;
}

export interface PlaceOptionOrderRequest {
  account_number: string;
  legs: OptionLegRequest[];
  quantity: string;
  /** Net premium of the whole strategy, always positive. */
  price: string;
  direction: 'debit' | 'credit';
  type: 'limit';
  time_in_force: string;
  ref_id: string;
}

export interface RobinhoodTransport {
  getAccount(accountNumber: string): Promise<RobinhoodAccount>;
  getPositions(accountNumber: string): Promise<RobinhoodPosition[]>;
  getOrders(
    accountNumber: string,
    filter?: { state?: string; since?: Date },
  ): Promise<RobinhoodOrder[]>;
  getOrder(accountNumber: string, orderId: string): Promise<RobinhoodOrder | null>;
  getQuote(symbol: string): Promise<RobinhoodQuote>;
  placeEquityOrder(request: PlaceEquityOrderRequest): Promise<RobinhoodOrder>;
  placeOptionOrder(request: PlaceOptionOrderRequest): Promise<RobinhoodOrder>;
  cancelOrder(accountNumber: string, orderId: string): Promise<RobinhoodOrder>;
}

/**
 * The transport this deployment actually has: none.
 *
 * It refuses every call and names the reason. A stub that returned plausible
 * order confirmations would be the single most dangerous object in this
 * codebase — a trader would believe they held a position that does not exist.
 */
export class UnconfiguredRobinhoodTransport implements RobinhoodTransport {
  /**
   * Rejects rather than throwing synchronously.
   *
   * The interface returns promises, so a caller may reasonably write
   * `transport.getAccount().catch(...)`. A method that threw before returning
   * one would escape that handler and crash a caller that had, correctly,
   * handled the failure.
   */
  private refuse<T>(operation: string): Promise<T> {
    return Promise.reject(
      new BrokerError(
        `No Robinhood credentials are configured, so ${operation} cannot be performed. ` +
          'This platform will not simulate a live broker response.',
        false,
      ),
    );
  }

  getAccount(): Promise<RobinhoodAccount> {
    return this.refuse('reading an account');
  }
  getPositions(): Promise<RobinhoodPosition[]> {
    return this.refuse('reading positions');
  }
  getOrders(): Promise<RobinhoodOrder[]> {
    return this.refuse('reading orders');
  }
  getOrder(): Promise<RobinhoodOrder | null> {
    return this.refuse('reading an order');
  }
  getQuote(): Promise<RobinhoodQuote> {
    return this.refuse('quoting a symbol');
  }
  placeEquityOrder(): Promise<RobinhoodOrder> {
    return this.refuse('placing an order');
  }
  placeOptionOrder(): Promise<RobinhoodOrder> {
    return this.refuse('placing an options order');
  }
  cancelOrder(): Promise<RobinhoodOrder> {
    return this.refuse('cancelling an order');
  }
}
