import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which commit is actually running.
 *
 * Read from the checkout rather than written into a constant somebody has to
 * remember to bump: a version number that is updated by hand is wrong exactly
 * when it matters, which is the moment somebody asks "am I looking at the new
 * one?".
 *
 * Read once, at start-up. The answer cannot change while the process lives —
 * pulling new code does not retrofit it into a running server — so re-reading
 * per request would cost a subprocess to tell the same story, and worse, a
 * pull made while the app is running would make the screen claim a version it
 * is not executing.
 */

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  // dist/lib → dist → apps/api → apps → repo, and the same under tsx from src.
  '../../../..',
);

export interface BuildInfo {
  /** Short commit hash, or null outside a git checkout. */
  commit: string | null;
  /** ISO timestamp of that commit, or null. */
  committedAt: string | null;
  /**
   * True when tracked files differ from that commit — so the commit named is
   * not the whole truth about what is running. Untracked files are ignored:
   * a stray note or an exported CSV in the folder changes nothing that runs.
   */
  modified: boolean;
}

function git(args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  if (cached) return cached;

  const commit = git(['rev-parse', '--short', 'HEAD']);
  const info: BuildInfo = {
    commit: commit === null || commit === '' ? null : commit,
    committedAt: commit === null ? null : (git(['log', '-1', '--format=%cI']) ?? null),
    // `--porcelain` with no untracked files: only what is actually running.
    modified: commit === null ? false : (git(['status', '--porcelain', '-uno']) ?? '') !== '',
  };

  cached = info;
  return info;
}

/** Testable without a repository: the shape of what git reported. */
export function buildInfoFrom(
  commit: string | null,
  committedAt: string | null,
  porcelain: string | null,
): BuildInfo {
  const trimmed = commit?.trim() ?? '';
  if (trimmed === '') {
    // Not a checkout. Saying "unknown" is the honest answer; inventing a
    // version would defeat the only purpose this serves.
    return { commit: null, committedAt: null, modified: false };
  }
  return {
    commit: trimmed,
    committedAt: committedAt?.trim() === '' ? null : (committedAt?.trim() ?? null),
    modified: (porcelain ?? '').trim() !== '',
  };
}
