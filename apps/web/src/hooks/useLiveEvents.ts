import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

interface WsEnvelope {
  event: string;
  correlationId: string;
  portfolioId: string | null;
  emittedAt: string;
  payload: unknown;
}

export type LiveStatus = 'connecting' | 'open' | 'closed';

/**
 * Subscribes to the API's event stream and invalidates the affected queries,
 * so the dashboard updates without polling or a page refresh (§61).
 */
export function useLiveEvents(enabled: boolean): {
  status: LiveStatus;
  lastEvent: WsEnvelope | null;
} {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('closed');
  const [lastEvent, setLastEvent] = useState<WsEnvelope | null>(null);
  const retryRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setStatus('closed');
      return;
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setStatus('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

      socket.onopen = () => {
        retryRef.current = 0;
        setStatus('open');
      };

      socket.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data as string) as WsEnvelope;
          setLastEvent(envelope);
          if (envelope.event.startsWith('portfolio') || envelope.event.startsWith('risk')) {
            void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
            void queryClient.invalidateQueries({ queryKey: ['gate'] });
          }
          if (envelope.event.startsWith('position')) {
            void queryClient.invalidateQueries({ queryKey: ['positions'] });
          }
          if (envelope.event === 'system.health') {
            void queryClient.invalidateQueries({ queryKey: ['health'] });
          }
        } catch {
          // A malformed frame is ignored rather than tearing down the socket.
        }
      };

      socket.onclose = () => {
        setStatus('closed');
        if (disposed) return;
        // Exponential backoff, capped — a flapping API must not be hammered.
        retryRef.current = Math.min(retryRef.current + 1, 6);
        reconnectTimer = window.setTimeout(connect, 500 * 2 ** retryRef.current);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [enabled, queryClient]);

  return { status, lastEvent };
}
