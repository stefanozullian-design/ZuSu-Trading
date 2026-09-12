#!/usr/bin/env node
/**
 * Runs a command with `.env` loaded, without adding a dependency for it.
 *
 * Nothing in this repository reads `.env` by itself — the API takes its
 * configuration from the environment, which is what you want in production and
 * what strands you locally: the README said to write a `.env` and then every
 * command ignored it. Prisma failed with "Environment variable not found:
 * DATABASE_URL", which names the symptom and not the cause.
 *
 * **Variables already set in the environment win.** `.env` fills gaps, never
 * overrides. The E2E suite and CI pass their own DATABASE_URL and must keep
 * getting it, so a convenience loader that clobbered an explicit value would
 * be a trap rather than a help.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

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

export function envWithFile(base, contents) {
  const fromFile = parseEnvFile(contents);
  const merged = { ...base };
  for (const [key, value] of Object.entries(fromFile)) {
    // Already set wins. Explicit beats ambient, always.
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('usage: node scripts/with-env.mjs <command> [args...]');
    process.exit(2);
  }

  const envPath = join(root, '.env');
  const env = existsSync(envPath)
    ? envWithFile(process.env, readFileSync(envPath, 'utf8'))
    : process.env;

  try {
    execFileSync(command, args, { cwd: root, env, stdio: 'inherit' });
  } catch (error) {
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
}

// Importable for tests; only runs the command when invoked directly.
if (process.argv[1] && process.argv[1].endsWith('with-env.mjs')) main();
