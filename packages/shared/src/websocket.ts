/** Names of the real-time channels published over the WebSocket gateway (§61). */
export const WsEvent = {
  QUOTE_UPDATED: 'quote.updated',
  SIGNAL_CREATED: 'signal.created',
  SIGNAL_EXPIRED: 'signal.expired',
  ORDER_UPDATED: 'order.updated',
  POSITION_UPDATED: 'position.updated',
  PORTFOLIO_UPDATED: 'portfolio.updated',
  RISK_WARNING: 'risk.warning',
  RISK_HALTED: 'risk.halted',
  SYSTEM_HEALTH: 'system.health',
} as const;
export type WsEvent = (typeof WsEvent)[keyof typeof WsEvent];

export interface WsEnvelope<TPayload = unknown> {
  event: WsEvent;
  /** Traces a payload back through signal → order → fill (§57). */
  correlationId: string;
  portfolioId: string | null;
  emittedAt: string;
  payload: TPayload;
}
