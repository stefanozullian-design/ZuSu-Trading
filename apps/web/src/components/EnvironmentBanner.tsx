import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EnvironmentInfo } from '@/lib/types';

const TONE_CLASS: Record<EnvironmentInfo['tone'], string> = {
  blue: 'env-demo',
  amber: 'env-paper',
  red: 'env-live',
};

/**
 * The environment must never be ambiguous (§3, §82). It is rendered as a
 * full-width bar, not a subtle chip, and LIVE additionally carries a warning.
 */
export function EnvironmentBanner({ environment }: { environment: EnvironmentInfo }) {
  const isLive = environment.environment === 'LIVE';
  return (
    <div
      role="status"
      aria-label={`Trading environment: ${environment.label}`}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-xs font-semibold tracking-wide',
        TONE_CLASS[environment.tone],
      )}
    >
      <span className="flex items-center gap-1.5 text-sm">
        <span aria-hidden>{environment.indicator}</span>
        {environment.label}
      </span>
      <span className="font-normal opacity-90">{environment.description}</span>
      {isLive && !environment.liveTradingAllowed && (
        <span className="ml-auto flex items-center gap-1.5 font-normal">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          Live trading is disabled on this deployment
        </span>
      )}
    </div>
  );
}
