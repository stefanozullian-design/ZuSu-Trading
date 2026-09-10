import { describe, expect, it } from 'vitest';
import { OrderStatus, SignalStatus } from './enums.js';
import {
  IllegalTransitionError,
  ORDER_TRANSITIONS,
  SIGNAL_TRANSITIONS,
  assertOrderTransition,
  assertSignalTransition,
  canTransitionOrder,
  canTransitionSignal,
  isTerminalOrderStatus,
} from './lifecycle.js';

describe('order lifecycle', () => {
  it('allows the ordinary happy path', () => {
    expect(canTransitionOrder(OrderStatus.CREATED, OrderStatus.SUBMITTED)).toBe(true);
    expect(canTransitionOrder(OrderStatus.SUBMITTED, OrderStatus.ACKNOWLEDGED)).toBe(true);
    expect(canTransitionOrder(OrderStatus.ACKNOWLEDGED, OrderStatus.PARTIALLY_FILLED)).toBe(true);
    expect(canTransitionOrder(OrderStatus.PARTIALLY_FILLED, OrderStatus.FILLED)).toBe(true);
  });

  it('never lets a terminal order come back to life', () => {
    for (const status of [
      OrderStatus.FILLED,
      OrderStatus.CANCELLED,
      OrderStatus.REJECTED,
      OrderStatus.EXPIRED,
    ]) {
      expect(isTerminalOrderStatus(status)).toBe(true);
      expect(ORDER_TRANSITIONS[status]).toHaveLength(0);
    }
  });

  it('refuses to skip submission', () => {
    expect(canTransitionOrder(OrderStatus.CREATED, OrderStatus.FILLED)).toBe(false);
    expect(() => assertOrderTransition(OrderStatus.CREATED, OrderStatus.FILLED)).toThrow(
      IllegalTransitionError,
    );
  });

  it('lets a cancel request lose the race with a fill', () => {
    expect(canTransitionOrder(OrderStatus.CANCEL_REQUESTED, OrderStatus.FILLED)).toBe(true);
  });

  it('only lets reconciliation resolve an UNKNOWN order', () => {
    expect(canTransitionOrder(OrderStatus.SUBMITTED, OrderStatus.UNKNOWN)).toBe(true);
    expect(canTransitionOrder(OrderStatus.UNKNOWN, OrderStatus.FILLED)).toBe(true);
    expect(canTransitionOrder(OrderStatus.UNKNOWN, OrderStatus.SUBMITTED)).toBe(false);
  });
});

describe('signal lifecycle', () => {
  it('routes every approval through the risk check', () => {
    expect(canTransitionSignal(SignalStatus.CREATED, SignalStatus.APPROVED)).toBe(false);
    expect(canTransitionSignal(SignalStatus.ANALYZING, SignalStatus.APPROVED)).toBe(false);
    expect(canTransitionSignal(SignalStatus.RISK_CHECK, SignalStatus.APPROVED)).toBe(true);
    expect(canTransitionSignal(SignalStatus.RISK_CHECK, SignalStatus.PENDING_APPROVAL)).toBe(true);
  });

  it('lets an approved but stale signal expire instead of executing', () => {
    expect(canTransitionSignal(SignalStatus.APPROVED, SignalStatus.EXPIRED)).toBe(true);
  });

  it('has no way out of a terminal state', () => {
    for (const status of [
      SignalStatus.CLOSED,
      SignalStatus.REJECTED,
      SignalStatus.EXPIRED,
      SignalStatus.SKIPPED,
      SignalStatus.CANCELLED,
      SignalStatus.FAILED,
    ]) {
      expect(SIGNAL_TRANSITIONS[status]).toHaveLength(0);
    }
    expect(() => assertSignalTransition(SignalStatus.REJECTED, SignalStatus.APPROVED)).toThrow(
      IllegalTransitionError,
    );
  });
});
