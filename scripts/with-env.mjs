#!/usr/bin/env node
/**
 * Runs a command with `.env` loaded, without adding a dependency for it.
 *
 * Nothing in this repository reads `.env` by itself — the API takes its
 * configuration from the environment, which is what you want in production and
 * what strands you locally: the README said to write a `.env` and then every
 * command ignored it. Prisma failed with "Environment variable not found:
 * DATABASE_URL", which names the symptom and not the cause.
 */
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFor, npmCommand, spawnOptions } from './env-tools.mjs';

export { parseEnvFile, envWithFile } from './env-tools.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('usage: node scripts/with-env.mjs <command> [args...]');
    process.exit(2);
  }

  const resolved = command === 'npm' ? npmCommand() : command;
  const result = spawnSync(
    resolved,
    args,
    spawnOptions({ cwd: root, env: loadEnvFor(root, process.env), stdio: 'inherit' }),
  );

  if (result.error) {
    console.error(`could not run ${resolved}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (process.argv[1] && process.argv[1].endsWith('with-env.mjs')) main();
