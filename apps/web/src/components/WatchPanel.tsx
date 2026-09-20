import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { NotificationRow } from '@/lib/types';

/**
 * What the watcher noticed while nobody was looking.
 *
 * The other half of "watch and tell". The dashboard's findings panel answers
 * "what is true now", which requires somebody to open it; this answers "what
 * changed since you last looked", which does not.
 *
 * Two kinds of message arrive here and they read differently on purpose. A
 * finding appearing is a thing to consider. A finding clearing is a thing to
 * stop considering — and it matters just as much, because without it a fixed
 * problem and an unwatched one look identical.
 *
 * Dismissing is per message and deliberately not "dismiss all": the point of
 * the list is that each item was read once.
 */

const CLEARED = 'PORTFOLIO_FINDING_CLEARED';

export function WatchPanel() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: NotificationRow[] }>('/api/notifications?limit=20'),
    refetchInterval: 60_000,
  });

  const dismiss = useMutation({
    mutationFn: (id: string) =>
      api<unknown>(`/api/notifications/${id}/dismiss`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const rows = data?.notifications ?? [];

  return (
    <Card role="region" aria-label="Since you last looked">
      <CardHeader className="flex-row items-center gap-2">
        <Bell className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <CardTitle>Since you last looked</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && <p className="text-sm text-muted-foreground">Checking…</p>}

        {!isLoading && rows.length === 0 && (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <BellOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {/*
              Said rather than left blank. An empty panel is indistinguishable
              from a watcher that stopped running.
            */}
            <span>
              Nothing new. The watcher checks each portfolio hourly and speaks only when something
              starts or stops being true.
            </span>
          </p>
        )}

        {rows.map((row) => {
          const cleared = row.event === CLEARED;
          return (
            <div
              key={row.id}
              className={cn(
                'rounded-md border p-2',
                cleared ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border bg-muted/30',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-medium">
                  {cleared && (
                    <Check className="mr-1 inline h-3 w-3 text-profit" aria-label="cleared" />
                  )}
                  {row.title}
                </p>
                <button
                  type="button"
                  className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => dismiss.mutate(row.id)}
                >
                  dismiss
                </button>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{row.body}</p>
              <p className="mt-1 text-[10px] text-muted-foreground/70">
                {formatDateTime(row.createdAt)}
              </p>
            </div>
          );
        })}

        {rows.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-[11px]"
            onClick={() => queryClient.invalidateQueries({ queryKey: ['notifications'] })}
          >
            Check again
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
