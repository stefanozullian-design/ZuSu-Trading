import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, explainApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { UNASSIGNED } from '@/hooks/useOwnerFilter';
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

/**
 * Chooses whose portfolios to look at.
 *
 * A dropdown rather than a row of buttons: three owners fit on a line and ten
 * do not, and this is a list that only grows. Adding an owner lives inside the
 * same control, because "the person I want is not in this list" is a thought
 * people have while looking at the list.
 */
export function OwnerFilter({
  ownerId,
  onChange,
}: {
  ownerId: string | null;
  onChange: (id: string | null) => void;
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

  if (!canSee || owners.length === 0) return null;

  if (adding) {
    return (
      <div className="flex flex-wrap items-end gap-1.5">
        <label className="block space-y-1">
          <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
            New owner
          </span>
          <Input
            id="owner-filter-new"
            className="h-8 w-56 text-xs"
            aria-label="New owner name"
            placeholder="Their name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
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
        {error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
    );
  }

  return (
    <label className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Owner</span>
      <select
        id="owner-filter"
        // Distinct from the "Owner" field on the create form: two controls
        // with the same accessible name are ambiguous to a screen reader in
        // exactly the way they are ambiguous to a test.
        aria-label="Owner filter"
        className="h-8 min-w-48 rounded-md border border-border bg-background px-2 text-xs"
        value={ownerId ?? ''}
        onChange={(e) => {
          if (e.target.value === '__new') {
            setAdding(true);
            return;
          }
          onChange(e.target.value === '' ? null : e.target.value);
        }}
      >
        <option value="">Everyone</option>
        {owners.map((owner) => (
          <option key={owner.id} value={owner.id}>
            {owner.name} ({owner.portfolioCount})
          </option>
        ))}
        {/*
          Always offered, even when every portfolio currently has an owner: it
          is how a person finds the one they forget to assign tomorrow, and a
          filter that hides its own blind spot is worse than no filter.
        */}
        <option value={UNASSIGNED}>Unassigned</option>
        {can('client:write') && <option value="__new">+ Add a new owner…</option>}
      </select>
    </label>
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
