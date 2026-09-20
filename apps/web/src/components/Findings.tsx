import { AlertTriangle, CircleAlert, Info, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { Finding, FindingSeverity } from '@/lib/types';

/**
 * What is worth knowing about this portfolio right now.
 *
 * The panel the dashboard exists for. Everything else on the page reports a
 * number and leaves the reader to decide whether it is a problem; this says
 * which ones are, against the limits the portfolio's own objective implies.
 *
 * Severity is carried by an icon and a word as well as a colour, because
 * colour alone fails for a colour-blind reader, in print, and under
 * forced-colours. The same three findings must be rankable without seeing hue
 * at all, which is why they are also sorted worst-first.
 *
 * An empty list is a real answer and says so. A panel that renders nothing
 * when it finds nothing is indistinguishable from one that failed to load.
 */

const RANK: Record<FindingSeverity, number> = { BREACH: 0, WATCH: 1, INFO: 2 };

const STYLE: Record<
  FindingSeverity,
  { label: string; tone: string; Icon: typeof Info; border: string }
> = {
  BREACH: {
    label: 'Breach',
    tone: 'text-loss',
    Icon: CircleAlert,
    border: 'border-red-500/30 bg-red-500/5',
  },
  WATCH: {
    label: 'Watch',
    tone: 'text-amber-300',
    Icon: AlertTriangle,
    border: 'border-amber-500/30 bg-amber-500/5',
  },
  INFO: {
    label: 'Note',
    tone: 'text-muted-foreground',
    Icon: Info,
    border: 'border-border bg-muted/30',
  },
};

export function Findings({ findings }: { findings: Finding[] }) {
  const sorted = [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);

  return (
    <Card role="region" aria-label="Worth knowing">
      <CardHeader>
        <CardTitle>Worth knowing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {sorted.length === 0 && (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-profit" aria-hidden />
            <span>
              Nothing stands out. Every holding is priced, and no weight is outside what this
              portfolio&rsquo;s objective allows.
            </span>
          </p>
        )}

        {sorted.map((finding) => {
          const style = STYLE[finding.severity];
          return (
            <div
              key={`${finding.code}:${finding.subject ?? ''}`}
              className={cn('rounded-md border p-2', style.border)}
            >
              <p className="flex items-start gap-2">
                <style.Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', style.tone)} aria-hidden />
                <span className="text-xs font-medium">
                  {/* The word, not only the colour. */}
                  <span className={cn('mr-1.5 uppercase tracking-wider', style.tone)}>
                    {style.label}
                  </span>
                  {finding.title}
                </span>
              </p>
              <p className="mt-1 pl-[22px] text-[11px] text-muted-foreground">{finding.detail}</p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
