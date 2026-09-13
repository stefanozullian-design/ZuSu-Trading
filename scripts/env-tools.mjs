/**
 * The two things every script in here needs, and neither of which the platform
 * gives us for free: `.env` loading, and an npm that works on Windows.
 */
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
