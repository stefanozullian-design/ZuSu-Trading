import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma, type PrismaClient } from '@prisma/client';

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

export class StaleClientError extends Error {
  constructor(readonly missing: { table: string; column: string }[]) {
    const names = missing.map((m) => `${m.table}.${m.column}`).join(', ');
    super(
      `The database has ${String(missing.length)} column(s) this build cannot read: ${names}.\n` +
        'Run "npm run db:generate" to rebuild the database client, then start again.\n' +
        'Applying a migration changes the database; it does not change the code that reads it.',
    );
    this.name = 'StaleClientError';
  }
}

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

/**
 * Refusing to start when the generated client is older than the database.
 *
 * `prisma migrate deploy` changes the database and not the code that reads it.
 * A migration that adds a column therefore leaves the client querying the old
 * set: the new field comes back undefined, every response carrying it fails
 * its own schema, and the screen says "something went wrong" about a column
 * that exists and is populated. The cause is two steps behind the symptom and
 * names itself nowhere — the same failure {@link assertDatabaseIsCurrent}
 * exists to prevent, arriving from the other direction.
 *
 * Only one direction is checked: a column the database has and the client does
 * not. The reverse is what a pending migration looks like, and that already
 * has its own error.
 */
export function staleFrom(
  databaseColumns: { table: string; column: string }[],
  known: Map<string, Set<string>>,
): { table: string; column: string }[] {
  return databaseColumns.filter(({ table, column }) => {
    const columns = known.get(table);
    // A table the client does not map at all is not staleness — it is a table
    // this application deliberately does not own.
    return columns !== undefined && !columns.has(column);
  });
}

/** The columns the generated client knows, by database table name. */
function columnsKnownToClient(): Map<string, Set<string>> {
  const known = new Map<string, Set<string>>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const table = model.dbName ?? model.name;
    const columns = new Set<string>();
    for (const field of model.fields) {
      // Relations are not columns; their foreign keys appear as scalars.
      if (field.kind === 'object') continue;
      columns.add(field.dbName ?? field.name);
    }
    known.set(table, columns);
  }
  return known;
}

export async function assertClientMatchesDatabase(db: PrismaClient): Promise<void> {
  let rows: { table: string; column: string }[];
  try {
    rows = await db.$queryRaw<{ table: string; column: string }[]>`
      SELECT table_name AS "table", column_name AS "column"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
    `;
  } catch {
    // Unable to inspect the schema is not evidence of staleness, and a guess
    // here would replace a good error further along with a worse one.
    return;
  }

  const stale = staleFrom(rows, columnsKnownToClient());
  if (stale.length > 0) throw new StaleClientError(stale);
}
