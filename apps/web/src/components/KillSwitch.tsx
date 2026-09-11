import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OctagonX, Play } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import type { PortfolioSummary } from '@/lib/types';

interface Props {
  portfolio: PortfolioSummary;
}

/**
 * Stop-all-trading control (§22, §23).
 *
 * Engaging is one click plus a typed reason — deliberately fast. Releasing the
 * halt needs the `kill_switch:release` permission, so a manager can always stop
 * trading but only an administrator can start it again.
 */
export function KillSwitch({ portfolio }: Props) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const halted = portfolio.tradingState !== 'ACTIVE';
  const canEngage = can('kill_switch:activate');
  const canRelease = can('kill_switch:release');

  const mutation = useMutation({
    mutationFn: async () => {
      if (halted) {
        return api(`/api/risk/portfolios/${portfolio.id}/resume`, {
          method: 'POST',
          body: { reason },
        });
      }
      return api('/api/risk/kill-switch', {
        method: 'POST',
        body: { reason, portfolioId: portfolio.id },
      });
    },
    onSuccess: async () => {
      setOpen(false);
      setReason('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['portfolios'] });
      await queryClient.invalidateQueries({ queryKey: ['gate'] });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    },
  });

  if (halted && !canRelease) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
        Trading is halted. An administrator must release it.
      </div>
    );
  }
  if (!halted && !canEngage) return null;

  return (
    <>
      <Button
        variant={halted ? 'outline' : 'destructive'}
        size="lg"
        className="w-full font-bold uppercase tracking-wide"
        onClick={() => setOpen(true)}
      >
        {halted ? (
          <>
            <Play className="h-4 w-4" aria-hidden /> Resume trading
          </>
        ) : (
          <>
            <OctagonX className="h-5 w-5" aria-hidden /> Stop all trading
          </>
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{halted ? 'Resume trading' : 'Stop all trading'}</DialogTitle>
            <DialogDescription>
              {halted
                ? `Trading on “${portfolio.name}” will be permitted again once the recorded reason is accepted.`
                : `New orders on “${portfolio.name}” will be blocked immediately and resting entry orders cancelled. Open positions stay open and keep being monitored.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="kill-reason">Reason (recorded in the audit log)</Label>
            <Input
              id="kill-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={halted ? 'Issue resolved — …' : 'Data feed looks wrong — …'}
              autoFocus
            />
            {error && <p className="text-xs text-loss">{error}</p>}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant={halted ? 'default' : 'destructive'}
              disabled={reason.trim().length < 3 || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? 'Working…' : halted ? 'Resume trading' : 'Stop all trading'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
