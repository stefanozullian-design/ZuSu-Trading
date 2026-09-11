import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ServiceStatus, SystemHealth } from '@/lib/types';

const DOT: Record<ServiceStatus, string> = {
  HEALTHY: 'bg-emerald-500',
  DEGRADED: 'bg-amber-500',
  DOWN: 'bg-red-500',
  DISABLED: 'bg-muted-foreground/40',
  UNKNOWN: 'bg-muted-foreground/40',
};

const LABEL: Record<string, string> = {
  MARKET_DATA: 'Market data',
  BROKER: 'Broker',
  CLAUDE: 'Claude',
  DATABASE: 'Database',
  REDIS: 'Redis',
  SCHEDULER: 'Scheduler',
  WEBSOCKET: 'WebSocket',
  RECONCILIATION: 'Reconciliation',
  NOTIFICATIONS: 'Notifications',
};

export function SystemHealthPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['health'],
    queryFn: () => api<SystemHealth>('/api/system/health'),
    refetchInterval: 15_000,
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>System health</CardTitle>
        {data && (
          <span className="text-[11px] text-muted-foreground tabular">
            checked {formatTime(data.checkedAt)}
          </span>
        )}
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-muted-foreground">Checking services…</p>}
        {error && <p className="text-sm text-loss">Health check unavailable.</p>}
        {data && (
          <ul className="space-y-1.5">
            {data.services.map((service) => (
              <li key={service.service} className="flex min-w-0 items-baseline gap-2 text-sm">
                <span
                  className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', DOT[service.status])}
                  aria-hidden
                />
                <span className="w-28 shrink-0">{LABEL[service.service] ?? service.service}</span>
                <span
                  className={cn(
                    'shrink-0 text-xs font-medium',
                    service.status === 'HEALTHY' && 'text-emerald-400',
                    service.status === 'DEGRADED' && 'text-amber-400',
                    service.status === 'DOWN' && 'text-red-400',
                    (service.status === 'DISABLED' || service.status === 'UNKNOWN') &&
                      'text-muted-foreground',
                  )}
                >
                  {service.status}
                </span>
                {service.detail && (
                  <span
                    className="min-w-0 truncate text-xs text-muted-foreground"
                    title={service.detail}
                  >
                    {service.detail}
                  </span>
                )}
                {service.latencyMs !== null && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular">
                    {service.latencyMs}ms
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
