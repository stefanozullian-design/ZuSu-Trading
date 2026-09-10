import { OrderStatus, SignalStatus } from './enums.js';

/**
 * Explicit state machines. Nothing in the system may represent a lifecycle with
 * a boolean (spec §10) and no component may jump states arbitrarily — every
 * transition is validated here.
 */

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> =
  Object.freeze({
    [OrderStatus.CREATED]: [OrderStatus.SUBMITTED, OrderStatus.REJECTED, OrderStatus.CANCELLED],
    // A transport failure after submit leaves the order UNKNOWN, never CANCELLED.
    [OrderStatus.SUBMITTED]: [
      OrderStatus.ACKNOWLEDGED,
      OrderStatus.PARTIALLY_FILLED,
      OrderStatus.FILLED,
      OrderStatus.REJECTED,
      OrderStatus.CANCEL_REQUESTED,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
      OrderStatus.UNKNOWN,
    ],
    [OrderStatus.ACKNOWLEDGED]: [
      OrderStatus.PARTIALLY_FILLED,
      OrderStatus.FILLED,
      OrderStatus.CANCEL_REQUESTED,
      OrderStatus.CANCELLED,
      OrderStatus.REJECTED,
      OrderStatus.EXPIRED,
      OrderStatus.UNKNOWN,
    ],
    [OrderStatus.PARTIALLY_FILLED]: [
      OrderStatus.PARTIALLY_FILLED,
      OrderStatus.FILLED,
      OrderStatus.CANCEL_REQUESTED,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
      OrderStatus.UNKNOWN,
    ],
    [OrderStatus.CANCEL_REQUESTED]: [
      OrderStatus.CANCELLED,
      // A cancel can lose the race with a fill.
      OrderStatus.FILLED,
      OrderStatus.PARTIALLY_FILLED,
      OrderStatus.REJECTED,
      OrderStatus.UNKNOWN,
    ],
    // Reconciliation is the only way out of UNKNOWN.
    [OrderStatus.UNKNOWN]: [
      OrderStatus.ACKNOWLEDGED,
      OrderStatus.PARTIALLY_FILLED,
      OrderStatus.FILLED,
      OrderStatus.CANCELLED,
      OrderStatus.REJECTED,
      OrderStatus.EXPIRED,
    ],
    [OrderStatus.FILLED]: [],
    [OrderStatus.CANCELLED]: [],
    [OrderStatus.REJECTED]: [],
    [OrderStatus.EXPIRED]: [],
  });

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = Object.freeze([
  OrderStatus.FILLED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED,
  OrderStatus.EXPIRED,
]);

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export const SIGNAL_TRANSITIONS: Readonly<Record<SignalStatus, readonly SignalStatus[]>> =
  Object.freeze({
    [SignalStatus.CREATED]: [
      SignalStatus.ANALYZING,
      SignalStatus.RISK_CHECK,
      SignalStatus.SKIPPED,
      SignalStatus.EXPIRED,
      SignalStatus.FAILED,
    ],
    [SignalStatus.ANALYZING]: [
      SignalStatus.RISK_CHECK,
      SignalStatus.SKIPPED,
      SignalStatus.REJECTED,
      SignalStatus.EXPIRED,
      SignalStatus.FAILED,
    ],
    // The risk engine is the only path to APPROVED/PENDING_APPROVAL.
    [SignalStatus.RISK_CHECK]: [
      SignalStatus.PENDING_APPROVAL,
      SignalStatus.APPROVED,
      SignalStatus.REJECTED,
      SignalStatus.EXPIRED,
      SignalStatus.FAILED,
    ],
    [SignalStatus.PENDING_APPROVAL]: [
      SignalStatus.APPROVED,
      SignalStatus.REJECTED,
      SignalStatus.EXPIRED,
      SignalStatus.CANCELLED,
    ],
    [SignalStatus.APPROVED]: [
      SignalStatus.ORDER_SUBMITTED,
      // An approval that goes stale must expire rather than execute (§48).
      SignalStatus.EXPIRED,
      SignalStatus.CANCELLED,
      SignalStatus.FAILED,
    ],
    [SignalStatus.ORDER_SUBMITTED]: [
      SignalStatus.PARTIALLY_FILLED,
      SignalStatus.FILLED,
      SignalStatus.CANCELLED,
      SignalStatus.REJECTED,
      SignalStatus.FAILED,
    ],
    [SignalStatus.PARTIALLY_FILLED]: [
      SignalStatus.PARTIALLY_FILLED,
      SignalStatus.FILLED,
      SignalStatus.POSITION_OPEN,
      SignalStatus.CANCELLED,
      SignalStatus.FAILED,
    ],
    [SignalStatus.FILLED]: [SignalStatus.POSITION_OPEN, SignalStatus.CLOSED, SignalStatus.FAILED],
    [SignalStatus.POSITION_OPEN]: [
      SignalStatus.EXIT_PENDING,
      SignalStatus.CLOSED,
      SignalStatus.FAILED,
    ],
    [SignalStatus.EXIT_PENDING]: [
      SignalStatus.CLOSED,
      SignalStatus.POSITION_OPEN,
      SignalStatus.FAILED,
    ],
    [SignalStatus.CLOSED]: [],
    [SignalStatus.REJECTED]: [],
    [SignalStatus.EXPIRED]: [],
    [SignalStatus.SKIPPED]: [],
    [SignalStatus.CANCELLED]: [],
    [SignalStatus.FAILED]: [],
  });

export const TERMINAL_SIGNAL_STATUSES: readonly SignalStatus[] = Object.freeze([
  SignalStatus.CLOSED,
  SignalStatus.REJECTED,
  SignalStatus.EXPIRED,
  SignalStatus.SKIPPED,
  SignalStatus.CANCELLED,
  SignalStatus.FAILED,
]);

export function canTransitionSignal(from: SignalStatus, to: SignalStatus): boolean {
  return (SIGNAL_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalSignalStatus(status: SignalStatus): boolean {
  return TERMINAL_SIGNAL_STATUSES.includes(status);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly entity: 'order' | 'signal',
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) throw new IllegalTransitionError('order', from, to);
}

export function assertSignalTransition(from: SignalStatus, to: SignalStatus): void {
  if (!canTransitionSignal(from, to)) throw new IllegalTransitionError('signal', from, to);
}
