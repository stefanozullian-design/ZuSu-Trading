import { useCallback, useEffect, useState } from 'react';

/**
 * The portfolio you are looking at, remembered across pages.
 *
 * Each page kept its own selection, so choosing a portfolio on the dashboard
 * and clicking through to Trading landed you back on whichever one happened to
 * be first. On a platform where the whole point is knowing which book you are
 * about to commit, a selector that silently resets is worse than an
 * inconvenience.
 *
 * Kept in `localStorage` rather than the URL: it is a preference, not a
 * destination, and a link someone pastes to a colleague should not carry their
 * choice of account with it. Every read and write is guarded — private windows
 * and blocked site data both make storage throw — and the page works without
 * it, simply forgetting between visits.
 */

const STORAGE_KEY = 'zusu.selectedPortfolioId';
/** In-tab fallback, so the choice still holds when storage is unavailable. */
let inMemory: string | null = null;
/** Same-tab listeners: the `storage` event only fires in *other* tabs. */
const listeners = new Set<(id: string | null) => void>();

function read(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? inMemory;
  } catch {
    return inMemory;
  }
}

function write(id: string | null): void {
  inMemory = id;
  try {
    if (id === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // A private window or blocked site data. The in-memory value still holds
    // for this tab, which is the case that matters while navigating.
  }
  for (const listener of listeners) listener(id);
}

/**
 * Returns the remembered id and a setter.
 *
 * `available` is the list of portfolios the caller can actually show. A
 * remembered id that is not in it — closed, revoked, or belonging to another
 * account — falls back to the first available rather than selecting nothing.
 */
export function useSelectedPortfolio(available: { id: string }[] | undefined): {
  selectedId: string;
  select: (id: string) => void;
} {
  const [stored, setStored] = useState<string | null>(() => read());

  useEffect(() => {
    const listener = (id: string | null) => setStored(id);
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setStored(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const select = useCallback((id: string) => {
    write(id);
  }, []);

  const isAvailable = stored !== null && (available ?? []).some((p) => p.id === stored);
  const selectedId = isAvailable ? stored : (available?.[0]?.id ?? '');

  return { selectedId, select };
}
