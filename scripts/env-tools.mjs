/**
 * The two things every script in here needs, and neither of which the platform
 * gives us for free: `.env` loading, and an npm that works on Windows.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `npm` on Windows is `npm.cmd`, and Node's spawn without a shell will not
 * find it. Getting this wrong produces `Error: spawn npm ENOENT`, which reads
 * like npm is missing when it is merely spelled differently.
 */
export function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * A shell command line, and the options to run it.
 *
 * Windows needs a shell: since Node 20.12 (the fix for CVE-2024-27980)
 * spawning a `.cmd` or `.bat` without one is refused outright with `EINVAL`,
 * an error that names nothing useful. But passing an *args array* alongside
 * `shell: true` makes Node print a DeprecationWarning about unescaped
 * arguments on every single start — which reads like a security problem to
 * anyone who is not a Node developer, on a tool whose whole point is not
 * alarming people without cause. One pre-joined command line avoids both.
 *
 * Every part of that line is a literal written in this repository. Nothing
 * read from a person or a file ever reaches a command line; that travels
 * through the environment instead.
 */
export function npmCommandLine(args) {
  return [npmCommand(), ...args].join(' ');
}

export function spawnOptions(base = {}) {
  return { ...base, shell: true };
}

/**
 * Options for a long-running child that must die with its parent.
 *
 * `shell: true` means the thing we spawn is a shell, which then runs npm,
 * which then runs tsx or vite. `child.kill()` reaches only the shell: the
 * grandchildren survive, keep their ports bound, and leave a stack that is
 * still serving pages after the window that started it has closed. The next
 * launch then reports "already running" and points at an orphan.
 *
 * On POSIX the fix is a process *group*: `detached` gives the child its own,
 * and a negative pid signals all of it. On Windows `detached` would open a
 * second console window, so the group is left alone and `taskkill /T` walks
 * the tree instead.
 */
export function supervisedOptions(base = {}) {
  return { ...spawnOptions(base), detached: process.platform !== 'win32' };
}

/** Stops a child started with {@link supervisedOptions}, and its descendants. */
export function killTree(child, signal = 'SIGTERM') {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // taskkill is an .exe, so it needs no shell — and must not get one, since
    // this runs while the parent is already shutting down.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      child.kill(signal);
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // No group (the child died between the check and here, or detached was
    // refused): fall back to the single process rather than give up.
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** A deliberately small parser: KEY=VALUE, `export` prefix, quotes, comments. */
export function parseEnvFile(contents) {
  const values = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Merges `.env` into a base environment.
 *
 * **Variables already set win.** `.env` fills gaps and never overrides, because
 * CI and the E2E suite pass their own DATABASE_URL and a loader that clobbered
 * it would point the run at somebody's development database without saying so.
 */
export function envWithFile(base, contents) {
  const fromFile = parseEnvFile(contents);
  const merged = { ...base };
  for (const [key, value] of Object.entries(fromFile)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

export function loadEnvFor(root, base) {
  const envPath = join(root, '.env');
  return existsSync(envPath) ? envWithFile(base, readFileSync(envPath, 'utf8')) : base;
}
