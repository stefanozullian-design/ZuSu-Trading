import type { WebSocket } from 'ws';
import { WsEvent, type WsEnvelope } from '@zusu/shared';
import type { Logger } from '../../lib/logger.js';

interface Subscriber {
  socket: WebSocket;
  userId: string;
  /** Portfolios this socket may receive events for; null means "all" (admin). */
  portfolioIds: Set<string> | null;
  isAlive: boolean;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * WebSocket fan-out (§61).
 *
 * Every message is filtered by the same portfolio scope as the REST API: a
 * socket only ever receives events for portfolios its user may read.
 */
export class WebSocketGateway {
  private readonly subscribers = new Set<Subscriber>();
  private heartbeat: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly logger: Logger) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.heartbeat = setInterval(() => this.pingAll(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const sub of this.subscribers) {
      try {
        sub.socket.close();
      } catch {
        // Socket already gone; nothing to clean up.
      }
    }
    this.subscribers.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  connectionCount(): number {
    return this.subscribers.size;
  }

  register(socket: WebSocket, userId: string, portfolioIds: string[] | null): void {
    const subscriber: Subscriber = {
      socket,
      userId,
      portfolioIds: portfolioIds === null ? null : new Set(portfolioIds),
      isAlive: true,
    };
    this.subscribers.add(subscriber);

    socket.on('pong', () => {
      subscriber.isAlive = true;
    });
    socket.on('close', () => this.subscribers.delete(subscriber));
    socket.on('error', (err: Error) => {
      this.logger.warn({ err: err.message, userId }, 'websocket error');
      this.subscribers.delete(subscriber);
    });
  }

  publish(
    event: WsEvent,
    portfolioId: string | null,
    payload: unknown,
    correlationId: string,
  ): void {
    const envelope: WsEnvelope = {
      event,
      correlationId,
      portfolioId,
      emittedAt: new Date().toISOString(),
      payload,
    };
    const message = JSON.stringify(envelope);

    for (const sub of this.subscribers) {
      if (!this.mayReceive(sub, portfolioId)) continue;
      try {
        sub.socket.send(message);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'failed to deliver websocket message');
        this.subscribers.delete(sub);
      }
    }
  }

  private mayReceive(sub: Subscriber, portfolioId: string | null): boolean {
    // System-wide events (health) reach everyone; portfolio events do not.
    if (portfolioId === null) return true;
    return sub.portfolioIds === null || sub.portfolioIds.has(portfolioId);
  }

  private pingAll(): void {
    for (const sub of this.subscribers) {
      if (!sub.isAlive) {
        try {
          sub.socket.terminate();
        } catch {
          // Ignore: the socket is being discarded either way.
        }
        this.subscribers.delete(sub);
        continue;
      }
      sub.isAlive = false;
      try {
        sub.socket.ping();
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }
}
