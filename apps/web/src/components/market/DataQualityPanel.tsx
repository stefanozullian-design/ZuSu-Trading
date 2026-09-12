import { CheckCircle2, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';
import type { QualityReport } from '@/lib/types';

interface Props {
  report: QualityReport | undefined;
}

/**
 * What the quality layer currently thinks of the feed.
 *
 * Shows resolved events alongside open ones on purpose: "nothing is wrong now"
 * is far more credible next to a list of things that were wrong and got
 * cleared than it is on its own.
 */
export function DataQualityPanel({ report }: Props) {
  if (!report) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Data quality</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  const openCount = report.feedWide.length + report.bySymbol.length;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Data quality</CardTitle>
        {report.ok ? (
          <Badge variant="success">CLEAN</Badge>
        ) : (
          <Badge variant="danger">{openCount} BLOCKING</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {report.ok ? (
          <div className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
            <p className="text-muted-foreground">
              No open blocking events. Every stored bar passed inspection for staleness, gaps,
              duplicates, impossible spreads and abnormal jumps.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {report.feedWide.map((event) => (
              <div
                key={`${event.issue}-${event.detectedAt}`}
                className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs"
              >
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden />
                <div>
                  <p className="font-medium">
                    {event.issue} · feed-wide
                    <span className="ml-1 font-normal text-muted-foreground">
                      blocks every non-demo portfolio
                    </span>
                  </p>
                  <p className="text-muted-foreground">{event.detail}</p>
                </div>
              </div>
            ))}
            {report.bySymbol.map((event) => (
              <div
                key={`${String(event.symbol)}-${event.issue}-${event.detectedAt}`}
                className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs"
              >
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
                <div>
                  <p className="font-medium">
                    {event.issue} · {event.symbol}
                    <span className="ml-1 font-normal text-muted-foreground">
                      blocks orders in this symbol only
                    </span>
                  </p>
                  <p className="text-muted-foreground">{event.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Recent inspections
          </p>
          {report.recent.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No events recorded. Every bar ingested so far was clean.
            </p>
          ) : (
            <div className="max-h-44 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="pb-1 font-medium">Issue</th>
                    <th className="pb-1 font-medium">Symbol</th>
                    <th className="pb-1 font-medium">State</th>
                    <th className="pb-1 text-right font-medium">Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {report.recent.map((event, i) => (
                    <tr key={i} className="border-t border-border/60">
                      <td className="py-1 pr-2" title={event.detail}>
                        {event.issue}
                      </td>
                      <td className="py-1 pr-2 text-muted-foreground">{event.symbol ?? 'feed'}</td>
                      <td className="py-1 pr-2">
                        {event.resolvedAt ? (
                          <span className="text-muted-foreground">resolved</span>
                        ) : event.blocking ? (
                          <span className="text-red-400">blocking</span>
                        ) : (
                          <span className="text-amber-400">noted</span>
                        )}
                      </td>
                      <td className="py-1 text-right tabular-nums text-muted-foreground">
                        {formatDateTime(event.detectedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
