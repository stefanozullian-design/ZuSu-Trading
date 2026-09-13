import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface Build {
  commit: string | null;
  committedAt: string | null;
  modified: boolean;
}

/**
 * Which commit is on screen.
 *
 * "Am I looking at the new one?" was unanswerable from the app: an old version
 * and a new one are identical until you notice a feature missing, and noticing
 * an absence is exactly what people are bad at. The commit is read from the
 * checkout by the server at start-up, so this is what is *running* rather than
 * what was last pulled — the two differ whenever somebody updates without
 * restarting, which is the case most likely to confuse.
 *
 * Never invented. Outside a git checkout the server reports null and this says
 * so, because a made-up version defeats the only thing it is for.
 */
export function BuildBadge() {
  const { data } = useQuery({
    queryKey: ['build'],
    queryFn: () => api<Build>('/api/system/version'),
    // It cannot change without the server restarting, and a restart means a
    // fresh page load anyway.
    staleTime: Infinity,
    retry: false,
  });

  if (!data) return null;

  const when =
    data.committedAt === null
      ? null
      : new Date(data.committedAt).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });

  if (data.commit === null) {
    return (
      <span
        aria-label="Running version"
        className="hidden text-[11px] text-muted-foreground sm:inline"
        title="This copy is not a git checkout, so there is no version to report."
      >
        version unknown
      </span>
    );
  }

  return (
    <span
      // A bare hash means nothing read aloud, and it gives this one name to
      // point at from anywhere else.
      aria-label="Running version"
      className="hidden font-mono text-[11px] text-muted-foreground sm:inline"
      title={
        (when ? `Committed ${when}. ` : '') +
        (data.modified
          ? 'Tracked files here differ from that commit, so this is not exactly it.'
          : 'This is exactly that commit.')
      }
    >
      {data.commit}
      {/*
        A checkout with local edits is not the commit it names. The mark is
        small and the tooltip says what it means; silently showing the hash
        alone would be the lie this badge exists to prevent.
      */}
      {data.modified && <span className="text-amber-400"> +edits</span>}
    </span>
  );
}
