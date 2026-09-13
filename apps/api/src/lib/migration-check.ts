import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';

/**
 * Refusing to start against a database that is behind the code.
 *
 * Pulling a change that adds a migration and forgetting to apply it produces
 * the worst kind of failure: the API starts perfectly, every page loads, and
 * then one feature returns "something went wrong" from a column that does not
 * exist. The cause is several steps behind the symptom and names itself
 * nowhere.
 *
 * So the check runs at start-up, and a database behind the code stops the
 * server with the command that fixes it. This is the same rule the rest of the
 * platform follows: refuse loudly rather than proceed into a state nobody can
 * diagnose from what they can see.
 */

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  // dist/lib → dist → apps/api, and src/lib → src → apps/api under tsx.
  '../../prisma/migrations',
);

export class PendingMigrationsError extends Error {
  constructor(readonly pending: string[]) {
    super(
      `The database is missing ${String(pending.length)} migration(s): ${pending.join(', ')}.\n` +
        'Run "npm run db:deploy" to apply them, then start again.\n' +
        'This usually means a "git pull" brought schema changes with it.',
    );
    this.name = 'PendingMigrationsError';
  }
}

/** Migration folder names on disk, in order. */
function migrationsOnDisk(dir = MIGRATIONS_DIR): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // A packaged deployment may not ship the migration folder. Nothing to
    // compare against is not the same as being behind, so say nothing.
    return [];
  }
}

/** Compares the two lists. Exported separately so it can be tested without a database. */
export function pendingFrom(onDisk: string[], applied: string[]): string[] {
  const done = new Set(applied);
  return onDisk.filter((name) => !done.has(name));
}

export async function assertDatabaseIsCurrent(
  db: PrismaClient,
  options: { dir?: string } = {},
): Promise<void> {
  const onDisk = migrationsOnDisk(options.dir ?? MIGRATIONS_DIR);
  if (onDisk.length === 0) return;

  let applied: string[];
  try {
    const rows = await db.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
    `;
    applied = rows.map((row) => row.migration_name);
  } catch {
    // No migrations table at all: the database has never been set up. That is
    // a different problem with its own clear error further along, and guessing
    // here would replace a good message with a worse one.
    return;
  }

  const pending = pendingFrom(onDisk, applied);
  if (pending.length > 0) throw new PendingMigrationsError(pending);
}
