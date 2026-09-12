import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { IndicatorSnapshot } from '@/lib/types';
import { num } from './chart-primitives';

interface Props {
  snapshot: IndicatorSnapshot | null;
}

/**
 * Indicator values as of the newest bar.
 *
 * A null renders as an em dash with "needs N bars" beside it, never as 0 and
 * never as a blank cell. The distinction matters: zero is a number a reader
 * would act on, and a blank looks like a rendering bug.
 */
export function IndicatorGrid({ snapshot }: Props) {
  if (!snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Indicators</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No stored bars for this symbol, so there is nothing to compute from.
          </p>
        </CardContent>
      </Card>
    );
  }

  const rows: { label: string; value: string | null; needs?: number; hint?: string }[] = [
    { label: 'Close', value: snapshot.close },
    { label: 'SMA 20', value: snapshot.sma20, needs: 20 },
    { label: 'SMA 50', value: snapshot.sma50, needs: 50 },
    { label: 'EMA 12', value: snapshot.ema12, needs: 12 },
    { label: 'EMA 26', value: snapshot.ema26, needs: 26 },
    { label: 'RSI 14', value: snapshot.rsi14, needs: 15, hint: rsiHint(snapshot.rsi14) },
    { label: 'MACD', value: snapshot.macd, needs: 26 },
    { label: 'MACD signal', value: snapshot.macdSignal, needs: 34 },
    { label: 'MACD histogram', value: snapshot.macdHistogram, needs: 34 },
    { label: 'Bollinger upper', value: snapshot.bollingerUpper, needs: 20 },
    { label: 'Bollinger middle', value: snapshot.bollingerMiddle, needs: 20 },
    { label: 'Bollinger lower', value: snapshot.bollingerLower, needs: 20 },
    { label: 'ATR 14', value: snapshot.atr14, needs: 14 },
    { label: 'VWAP (session)', value: snapshot.vwap },
    { label: 'Stochastic %K', value: snapshot.stochasticK, needs: 14 },
    { label: 'Stochastic %D', value: snapshot.stochasticD, needs: 16 },
    { label: 'OBV', value: snapshot.obv },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-2">
        <CardTitle>Indicators</CardTitle>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {snapshot.barsAvailable} bars · computed locally
        </span>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-right font-mono tabular-nums">
                {row.value === null ? (
                  <span
                    className="text-muted-foreground"
                    title={
                      row.needs
                        ? `Needs ${String(row.needs)} bars; ${String(snapshot.barsAvailable)} stored`
                        : 'Not defined yet'
                    }
                  >
                    —
                    {row.needs !== undefined && (
                      <span className="ml-1 text-[10px]">needs {row.needs}</span>
                    )}
                  </span>
                ) : (
                  <>
                    {formatIndicator(row.value)}
                    {row.hint && (
                      <span className="ml-1.5 text-[10px] text-muted-foreground">{row.hint}</span>
                    )}
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function formatIndicator(value: string): string {
  const parsed = num(value);
  if (parsed === null) return value;
  const abs = Math.abs(parsed);
  if (abs >= 1_000_000) return `${(parsed / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return parsed.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return parsed.toFixed(abs < 1 ? 4 : 2);
}

/** A plain-language note, not a recommendation. */
function rsiHint(value: string | null): string | undefined {
  const parsed = num(value);
  if (parsed === null) return undefined;
  if (parsed >= 70) return 'overbought';
  if (parsed <= 30) return 'oversold';
  return undefined;
}
