import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { api, explainApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import type { Owner } from '@/lib/types';

/**
 * Managing the people whose money is under management.
 *
 * There is no delete, and the panel says so rather than leaving somebody
 * hunting for one. An owner is referenced by append-only audit rows from the
 * moment they exist; removing them would leave a trading record pointing at
 * nothing, or require rewriting it, and a record that can be rewritten is not
 * a record. Retiring does what "delete" is usually meant to achieve — they
 * leave every picker and their history stays.
 */
export function OwnersPanel({ onClose }: { onClose: () => void }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; contactEmail: string }>({
    name: '',
    contactEmail: '',
  });
  const [error, setError] = useState<string | null>(null);

  const { data: owners, isLoading } = useQuery({
    queryKey: ['owners', 'all'],
    // Retired owners included: this is the one screen where somebody needs to
    // see them, to bring one back.
    queryFn: () => api<Owner[]>('/api/clients?includeInactive=true'),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['owners'] });
    await queryClient.invalidateQueries({ queryKey: ['portfolios'] });
  };

  const create = useMutation({
    mutationFn: () =>
      api<Owner>('/api/clients', { method: 'POST', body: { name: newName.trim() } }),
    onSuccess: async () => {
      setError(null);
      setNewName('');
      setAdding(false);
      await refresh();
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const patch = useMutation({
    mutationFn: (input: { id: string; body: Record<string, unknown> }) =>
      api<Owner>(`/api/clients/${input.id}`, { method: 'PATCH', body: input.body }),
    onSuccess: async () => {
      setError(null);
      setEditing(null);
      await refresh();
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const canWrite = can('client:write');

  return (
    <Card className="max-w-3xl">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Owners</CardTitle>
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">Close owners</span>
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {!canWrite && (
          // Said plainly rather than by absence: a panel with everything
          // greyed out and no explanation reads as broken.
          <p className="rounded-md border border-border bg-muted/30 p-2 text-[11px] text-muted-foreground">
            You can see who the owners are but not change them. Registering or editing an owner
            needs an administrator account.
          </p>
        )}

        {isLoading && <p className="text-muted-foreground">Loading owners…</p>}

        {owners && owners.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-semibold">Name</th>
                  <th className="py-1 text-left font-semibold">Contact</th>
                  <th className="py-1 text-right font-semibold">Portfolios</th>
                  <th className="py-1 text-right font-semibold" />
                </tr>
              </thead>
              <tbody>
                {owners.map((owner) =>
                  editing === owner.id ? (
                    <tr key={owner.id} className="border-t border-border">
                      <td className="py-1.5 pr-2">
                        <Input
                          id={`owner-name-${owner.id}`}
                          className="h-7 text-xs"
                          aria-label="Owner name"
                          value={draft.name}
                          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <Input
                          id={`owner-email-${owner.id}`}
                          className="h-7 text-xs"
                          aria-label="Owner contact email"
                          placeholder="optional"
                          value={draft.contactEmail}
                          onChange={(e) => setDraft({ ...draft, contactEmail: e.target.value })}
                        />
                      </td>
                      <td />
                      <td className="py-1.5 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={draft.name.trim().length < 2 || patch.isPending}
                          onClick={() =>
                            patch.mutate({
                              id: owner.id,
                              body: {
                                name: draft.name.trim(),
                                // Emptied means cleared, not unchanged: a
                                // field that can only be set and never cleared
                                // makes a typo permanent.
                                contactEmail:
                                  draft.contactEmail.trim() === ''
                                    ? null
                                    : draft.contactEmail.trim(),
                              },
                            })
                          }
                        >
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={owner.id} className="border-t border-border">
                      <td className="py-1.5">
                        {owner.name}
                        {!owner.isActive && (
                          <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                            retired
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-muted-foreground">{owner.contactEmail ?? '—'}</td>
                      <td className="py-1.5 text-right tabular-nums">{owner.portfolioCount}</td>
                      <td className="py-1.5 text-right">
                        {canWrite && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setDraft({
                                  name: owner.name,
                                  contactEmail: owner.contactEmail ?? '',
                                });
                                setEditing(owner.id);
                              }}
                            >
                              <Pencil className="h-3 w-3" aria-hidden />
                              <span className="sr-only">Edit {owner.name}</span>
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={patch.isPending}
                              title={
                                owner.isActive
                                  ? 'Takes them out of every picker. Their history is kept and they can be brought back.'
                                  : 'Puts them back in the pickers.'
                              }
                              onClick={() =>
                                patch.mutate({
                                  id: owner.id,
                                  body: { isActive: !owner.isActive },
                                })
                              }
                            >
                              {owner.isActive ? 'Retire' : 'Bring back'}
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}

        {owners && owners.length === 0 && (
          <p className="text-muted-foreground">
            Nobody yet. An owner is a person whose money you manage — you, a relative, anyone whose
            portfolios you keep separate.
          </p>
        )}

        {error && (
          <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-[11px] text-red-400">
            {error}
          </p>
        )}

        {canWrite &&
          (adding ? (
            <div className="flex flex-wrap items-end gap-1.5">
              <label className="block space-y-1">
                <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Their name
                </span>
                <Input
                  id="owners-panel-new"
                  className="h-8 w-56 text-xs"
                  aria-label="New owner name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newName.trim().length >= 2) create.mutate();
                    if (e.key === 'Escape') setAdding(false);
                  }}
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={newName.trim().length < 2 || create.isPending}
                onClick={() => create.mutate()}
              >
                Add
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              Add an owner
            </Button>
          ))}

        <p className="text-[11px] text-muted-foreground">
          There is no delete, and that is deliberate. An owner appears in the audit log from the
          moment they exist, and those rows cannot be rewritten. Retiring takes them out of every
          picker and keeps the history — which is what deleting is usually meant to achieve.
        </p>
      </CardContent>
    </Card>
  );
}
