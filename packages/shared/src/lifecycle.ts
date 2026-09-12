import { ExecutionMode, OrderStatus, SignalStatus, StrategyStage } from './enums.js';

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
    readonly entity: 'order' | 'signal' | 'strategy stage' | 'execution mode',
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

/**
 * Strategy stage progression (§10).
 *
 * A strategy walks DRAFT to LIVE one step at a time, and each step is taken by
 * a person. Nothing skips ahead: a version cannot be approved without having
 * been backtested and paper-traded, because the whole point of the ladder is
 * that evidence accumulates before real money is involved.
 *
 * RETIRED is reachable from anywhere — stopping is always allowed. Going back
 * to DRAFT is not: an approved definition is immutable, so a change means a
 * new version, not a demotion of this one.
 */
export const STRATEGY_STAGE_TRANSITIONS: Readonly<Record<StrategyStage, readonly StrategyStage[]>> =
  Object.freeze({
    DRAFT: Object.freeze(['BACKTEST', 'RETIRED'] as StrategyStage[]),
    BACKTEST: Object.freeze(['PAPER', 'DRAFT', 'RETIRED'] as StrategyStage[]),
    PAPER: Object.freeze(['REVIEW', 'BACKTEST', 'RETIRED'] as StrategyStage[]),
    REVIEW: Object.freeze(['APPROVED', 'PAPER', 'RETIRED'] as StrategyStage[]),
    /** Approved but not yet switched on. The last step is separate on purpose. */
    APPROVED: Object.freeze(['LIVE', 'RETIRED'] as StrategyStage[]),
    LIVE: Object.freeze(['RETIRED'] as StrategyStage[]),
    RETIRED: Object.freeze([] as StrategyStage[]),
  });

export function canTransitionStrategyStage(from: StrategyStage, to: StrategyStage): boolean {
  return STRATEGY_STAGE_TRANSITIONS[from].includes(to);
}

/**
 * Every version's definition is frozen, from the moment it is written.
 *
 * There was a stage-based version of this ("frozen once APPROVED"), and it was
 * a half-truth: a database trigger blocks any change to a definition at any
 * stage, draft included. A helper that said a draft was editable would have
 * had callers build an edit form that could only ever fail. Changing a rule
 * means adding a version — there is no other path, at any stage.
 */
export function isStrategyDefinitionFrozen(_stage: StrategyStage): true {
  return true;
}

export function assertStrategyStageTransition(from: StrategyStage, to: StrategyStage): void {
  if (!canTransitionStrategyStage(from, to)) {
    throw new IllegalTransitionError('strategy stage', from, to);
  }
}

/**
 * The automation ladder (§10, Phase 9).
 *
 * OBSERVE → MANUAL_APPROVAL → LIMITED_AUTO → FULL_AUTO, one rung at a time,
 * each rung climbed by a person. Two properties matter more than the list:
 *
 *   - **No rung can be skipped going up.** MANUAL_APPROVAL to FULL_AUTO is not
 *     a transition, because the whole purpose of LIMITED_AUTO is to be the
 *     period during which someone watches the thing trade with caps on.
 *   - **Every rung can be descended to, from anywhere.** Turning automation
 *     down must never be blocked by a state machine. Someone reaching for the
 *     brake is not a transition to validate; it is the one thing that always
 *     works.
 */
export const EXECUTION_MODE_LADDER: readonly ExecutionMode[] = Object.freeze([
  ExecutionMode.OBSERVE,
  ExecutionMode.MANUAL_APPROVAL,
  ExecutionMode.LIMITED_AUTO,
  ExecutionMode.FULL_AUTO,
]);

function rungOf(mode: ExecutionMode): number {
  return EXECUTION_MODE_LADDER.indexOf(mode);
}

export function canTransitionExecutionMode(from: ExecutionMode, to: ExecutionMode): boolean {
  const fromRung = rungOf(from);
  const toRung = rungOf(to);
  if (fromRung < 0 || toRung < 0 || fromRung === toRung) return false;
  // Down: any distance. Up: exactly one rung.
  return toRung < fromRung || toRung === fromRung + 1;
}

export function assertExecutionModeTransition(from: ExecutionMode, to: ExecutionMode): void {
  if (!canTransitionExecutionMode(from, to)) {
    throw new IllegalTransitionError('execution mode', from, to);
  }
}

/** True when the mode submits orders without waiting for a person. */
export function isAutomatic(mode: ExecutionMode): boolean {
  return mode === ExecutionMode.LIMITED_AUTO || mode === ExecutionMode.FULL_AUTO;
}
