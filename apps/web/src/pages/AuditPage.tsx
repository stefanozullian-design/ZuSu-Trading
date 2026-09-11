import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';
import type { AuditEntry } from '@/lib/types';

interface ChainStatus {
  valid: boolean;
  checked: number;
  brokenAtSeq?: string;
  reason?: string;
}

export function AuditPage() {
  const entries = useQuery({
    queryKey: ['audit'],
    queryFn: () =>
      api<{ entries: AuditEntry[]; nextCursor: string | null }>('/api/audit?limit=100'),
  });
  const chain = useQuery({
    queryKey: ['audit-verify'],
    queryFn: () => api<ChainStatus>('/api/audit/verify'),
  });

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 px-3 py-4 sm:px-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Audit chain integrity</CardTitle>
        </CardHeader>
        <CardContent>
          {chain.isLoading && <p className="text-sm text-muted-foreground">Verifying…</p>}
          {chain.data && (
            <div className="flex items-start gap-2">
              {chain.data.valid ? (
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
              ) : (
                <ShieldX className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden />
              )}
              <p className="text-sm">
                {chain.data.valid ? (
                  <>
                    {chain.data.checked} entries verified. Every row hashes to its predecessor, and
                    the database rejects updates and deletes outright.
                  </>
                ) : (
                  <span className="text-loss">
                    Chain broken at sequence {chain.data.brokenAtSeq}: {chain.data.reason}
                  </span>
                )}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit log</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {entries.isLoading && (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Loading entries…</p>
          )}
          {entries.data?.entries.length === 0 && (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No entries.</p>
          )}
          <ul className="divide-y divide-border">
            {entries.data?.entries.map((entry) => (
              <li key={entry.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={toneFor(entry.action)}>{entry.action}</Badge>
                  <span className="text-xs text-muted-foreground tabular">
                    {formatDateTime(entry.occurredAt)}
                  </span>
                  {entry.environment && (
                    <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                      {entry.environment}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-sm">
                  <span className="text-muted-foreground">
                    {entry.actorEmail ?? entry.actorType.toLowerCase()}
                  </span>
                  {entry.entityType && (
                    <>
                      {' → '}
                      <span className="font-mono text-xs">
                        {entry.entityType}
                        {entry.entityId ? `:${entry.entityId.slice(0, 8)}` : ''}
                      </span>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function toneFor(action: string): 'default' | 'success' | 'warning' | 'danger' | 'neutral' {
  if (action.includes('FAILED') || action.includes('DENIED') || action.includes('REUSE')) {
    return 'danger';
  }
  if (action.includes('KILL_SWITCH') || action.includes('HALTED')) return 'warning';
  if (action.startsWith('LOGIN') || action.startsWith('MFA')) return 'default';
  return 'neutral';
}
