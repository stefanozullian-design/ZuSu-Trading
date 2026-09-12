import { CalendarDays, CircleSlash, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CalendarView, TradabilityVerdict } from '@/lib/types';

interface Props {
  calendar: CalendarView | undefined;
  tradability: TradabilityVerdict | undefined;
}

const SESSION_LABEL: Record<string, string> = {
  REGULAR: 'Regular session',
  PRE_MARKET: 'Pre-market',
  AFTER_HOURS: 'After hours',
  CLOSED: 'Closed',
  HALTED: 'Halted',
};

/**
 * Session state and the days around today.
 *
 * The times shown are read from stored calendar rows, not derived at render
 * time — which is why a holiday or an early close appears here as a different
 * row rather than as a special case in the UI.
 */
export function SessionPanel({ calendar, tradability }: Props) {
  if (!calendar) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Market session</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  const open = calendar.session === 'REGULAR';
  const extended = calendar.session === 'PRE_MARKET' || calendar.session === 'AFTER_HOURS';

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Market session · {calendar.marketCode}</CardTitle>
        <Badge variant={open ? 'success' : extended ? 'warning' : 'neutral'}>
          {SESSION_LABEL[calendar.session] ?? calendar.session}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {tradability && (
          <div className="flex items-start gap-2 text-sm">
            {tradability.tradable ? (
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
            ) : (
              <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <div>
              <p>
                <span className="font-medium">{tradability.symbol}</span>{' '}
                {tradability.tradable ? 'is tradable now.' : 'cannot be traded now.'}
              </p>
              {tradability.reason && (
                <p className="text-xs text-muted-foreground">{tradability.reason}</p>
              )}
            </div>
          </div>
        )}

        {calendar.openHalts.length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
            <p className="font-medium">{calendar.openHalts.length} symbol(s) halted</p>
            <ul className="mt-0.5 text-muted-foreground">
              {calendar.openHalts.map((halt) => (
                <li key={halt.symbol}>
                  {halt.symbol} — {halt.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <p className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <CalendarDays className="h-3 w-3" aria-hidden />
            Calendar
          </p>
          {calendar.days.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No calendar rows loaded for this market. Nothing is tradable until it is synced — the
              platform never assumes a market it knows nothing about is open.
            </p>
          ) : (
            <table className="w-full text-left text-xs">
              <tbody>
                {calendar.days.map((day) => (
                  <tr key={day.date} className="border-t border-border/60">
                    <td className="py-1 pr-2 tabular-nums">{day.date}</td>
                    <td className="py-1 pr-2">
                      {day.isTradingDay ? (
                        <span className="tabular-nums text-muted-foreground">
                          {clock(day.regularOpen)}–{clock(day.regularClose)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">closed</span>
                      )}
                    </td>
                    <td className="py-1 text-right text-muted-foreground">
                      {day.holidayName ?? (day.isEarlyClose ? 'early close' : '')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function clock(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}
