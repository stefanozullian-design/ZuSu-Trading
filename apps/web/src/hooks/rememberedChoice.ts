import { useCallback, useEffect, useState } from 'react';

/**
 * A small preference, remembered across pages and visits.
 *
 * Kept in `localStorage` rather than the URL: these are preferences, not
 * destinations, and a link someone pastes to a colleague should not carry
 * their choice of account or owner with it.
 *
 * Every read and write is guarded. A private window and blocked site data both
 * make storage *throw* rather than return nothing, so an unguarded read takes
 * the page down instead of forgetting a preference. When storage is
 * unavailable an in-memory value still holds for the tab, which is the case
 * that matters while navigating.
 */
export function rememberedChoice(storageKey: string): {
  read: () => string | null;
  write: (value: string | null) => void;
  subscribe: (listener: (value: string | null) => void) => () => void;
} {
  let inMemory: string | null = null;
  // Same-tab listeners: the `storage` event only fires in *other* tabs, so a
  // second component in this one would never hear about the change.
  const listeners = new Set<(value: string | null) => void>();

  const read = (): string | null => {
    try {
      return window.localStorage.getItem(storageKey) ?? inMemory;
    } catch {
      return inMemory;
    }
  };

  const write = (value: string | null): void => {
    inMemory = value;
    try {
      if (value === null) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, value);
    } catch {
      /* see above */
    }
    for (const listener of listeners) listener(value);
  };

  const subscribe = (listener: (value: string | null) => void): (() => void) => {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) listener(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', onStorage);
    };
  };

  return { read, write, subscribe };
}

/** Binds a {@link rememberedChoice} to React state. */
export function useRemembered(store: ReturnType<typeof rememberedChoice>): {
  value: string | null;
  set: (value: string | null) => void;
} {
  const [value, setValue] = useState<string | null>(() => store.read());

  useEffect(() => store.subscribe(setValue), [store]);

  const set = useCallback((next: string | null) => store.write(next), [store]);

  return { value, set };
}
