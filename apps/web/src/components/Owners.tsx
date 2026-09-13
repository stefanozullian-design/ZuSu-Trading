import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, explainApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { UNASSIGNED } from '@/hooks/useOwnerFilter';
import { cn } from '@/lib/utils';
import type { Owner, PortfolioObjective } from '@/lib/types';

/**
 * Owners — the people whose money is under management.
 *
 * The API calls them clients, because that is what they are in a firm. On
 * screen they are owners, because one person managing their own money and
 * their mother's does not think of their mother as a client.
 *
 * Registering a new owner needs `client:write`, which is administrator-only:
 * saying whose money is under management is an administrative act, and someone
 * who could invent an owner could quietly move a book to one. Assigning a
 * portfolio to an owner that already exists is an ordinary manager's job.
 */

export const OBJECTIVE_TITLES: Record<PortfolioObjective, string> = {
  DAY_TRADING: 'Day trading',
  GROWTH: 'Growth',
  INCOME: 'Income',
  RETIREMENT: 'Retirement',
};

export const OBJECTIVE_BLURBS: Record<PortfolioObjective, string> = {
  DAY_TRADING: 'Bought and sold within days. The widest limits.',
  GROWTH: 'Held for years, aiming to be worth more later.',
  INCOME: 'Held for the dividends it pays rather than the price.',
  RETIREMENT: 'Money that must still be there in decades. The tightest limits.',
};

/**
 * The owner roster.
 *
 * Returns an empty list rather than an error for a caller without
 * `client:read` — a viewer simply sees no owner controls, instead of a panel
 * that reports a failure they can do nothing about.
 */
export function useOwners(): { owners: Owner[]; canSee: boolean } {
  const { can } = useAuth();
  const canSee = can('client:read');

  const { data } = useQuery({
    queryKey: ['owners'],
    queryFn: () => api<Owner[]>('/api/clients'),
    enabled: canSee,
    staleTime: 60_000,
  });

  return { owners: data ?? [], canSee };
}

/** A row of buttons: everyone, each owner, and the unassigned ones. */
export function OwnerFilter({
  ownerId,
  onChange,
}: {
  ownerId: string | null;
  onChange: (id: string | null) => void;
}) {
  const { owners, canSee } = useOwners();

  // Nothing to filter by. One owner and no unassigned portfolios is the
  // single-person case, where a filter row is furniture.
  if (!canSee || owners.length === 0) return null;

  const option = (label: string, value: string | null, count?: number) => (
    <button
      key={label}
      type="button"
      onClick={() => onChange(value)}
      className={cn(
        'shrink-0 rounded-full border px-3 py-1 text-xs transition-colors',
        ownerId === value
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
      {count === undefined ? null : <span className="ml-1.5 tabular-nums opacity-60">{count}</span>}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[10px] uppercase tracking-wider text-muted-foreground">Owner</span>
      {option('Everyone', null)}
      {owners.map((owner) => option(owner.name, owner.id, owner.portfolioCount))}
      {/*
        Always offered, even when every portfolio currently has an owner: it is
        how a person finds the one they forget to assign tomorrow, and a filter
        that hides its own blind spot is worse than no filter.
      */}
      {option('Unassigned', UNASSIGNED)}
    </div>
  );
}

/** What a portfolio is for, or an honest dash when nobody has said. */
export function ObjectiveBadge({ objective }: { objective: PortfolioObjective | null }) {
  if (!objective) {
    return (
      <span className="text-muted-foreground" title="Nobody has said what this portfolio is for.">
        — not stated
      </span>
    );
  }
  return <span title={OBJECTIVE_BLURBS[objective]}>{OBJECTIVE_TITLES[objective]}</span>;
}

/**
 * Picks an owner, and offers to register a new one when the caller may.
 *
 * `null` is a real choice here and stays selectable: a portfolio that is
 * genuinely nobody's yet is better recorded as unassigned than filed under
 * whoever happened to be first in the list.
 */
export function OwnerPicker({
  value,
  onChange,
  id,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  id: string;
}) {
  const { can } = useAuth();
  const { owners, canSee } = useOwners();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api<Owner>('/api/clients', { method: 'POST', body: { name: name.trim() } }),
    onSuccess: async (owner) => {
      setError(null);
      setName('');
      setAdding(false);
      await queryClient.invalidateQueries({ queryKey: ['owners'] });
      onChange(owner.id);
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  if (!canSee) return null;

  if (adding) {
    return (
      <div className="space-y-1">
        <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
          New owner
        </span>
        <div className="flex gap-1.5">
          <Input
            id={`${id}-new-owner`}
            className="h-8 text-xs"
            aria-label="New owner name"
            placeholder="Their name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={name.trim().length < 2 || create.isPending}
            onClick={() => create.mutate()}
          >
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <label className="block space-y-1">
      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
        Owner
      </span>
      <div className="flex gap-1.5">
        <select
          id={id}
          aria-label="Owner"
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">Unassigned</option>
          {owners.map((owner) => (
            <option key={owner.id} value={owner.id}>
              {owner.name}
            </option>
          ))}
        </select>
        {can('client:write') && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            New
          </Button>
        )}
      </div>
    </label>
  );
}

/** Picks what the money is for, and says what that changes. */
export function ObjectivePicker({
  value,
  onChange,
  id,
}: {
  value: PortfolioObjective | null;
  onChange: (objective: PortfolioObjective | null) => void;
  id: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
        What it is for
      </span>
      <select
        id={id}
        aria-label="What it is for"
        className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
        value={value ?? ''}
        onChange={(e) =>
          onChange(e.target.value === '' ? null : (e.target.value as PortfolioObjective))
        }
      >
        <option value="">Not stated</option>
        {(Object.keys(OBJECTIVE_TITLES) as PortfolioObjective[]).map((objective) => (
          <option key={objective} value={objective}>
            {OBJECTIVE_TITLES[objective]}
          </option>
        ))}
      </select>
      {value && <p className="text-[11px] text-muted-foreground">{OBJECTIVE_BLURBS[value]}</p>}
    </label>
  );
}
