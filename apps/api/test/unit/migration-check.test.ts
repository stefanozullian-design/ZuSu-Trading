import { describe, expect, it } from 'vitest';
import { PendingMigrationsError, pendingFrom, staleFrom } from '../../src/lib/migration-check.js';

/**
 * Starting against a database that is behind the code.
 *
 * The failure this prevents is a particularly bad one: the server starts, every
 * page loads, and one feature returns "something went wrong" from a column that
 * does not exist yet. The cause — a `git pull` that brought a migration — is
 * several steps behind the symptom and names itself nowhere.
 */
describe('pending migrations', () => {
  it('finds what is on disk and not in the database', () => {
    expect(pendingFrom(['a', 'b', 'c'], ['a', 'b'])).toEqual(['c']);
  });

  it('is quiet when the database is current', () => {
    expect(pendingFrom(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('ignores migrations the database has but the checkout does not', () => {
    // Checking out an older commit is a deliberate act, and the database being
    // ahead breaks nothing that this check could usefully warn about.
    expect(pendingFrom(['a'], ['a', 'b'])).toEqual([]);
  });

  it('names the fix in the error, not just the problem', () => {
    const error = new PendingMigrationsError(['20260913020000_position_origin']);
    expect(error.message).toContain('20260913020000_position_origin');
    expect(error.message).toContain('npm run db:deploy');
    // The step people actually forget.
    expect(error.message).toContain('git pull');
  });
});

/**
 * The other direction: a database ahead of the code that reads it.
 *
 * `prisma migrate deploy` changes the database and not the generated client,
 * so applying a migration without regenerating leaves the API querying the old
 * column set. The new field comes back undefined, the response fails its own
 * schema, and the screen says "something went wrong" about a column that
 * exists and is populated — a cause two steps behind its symptom.
 */
describe('staleFrom', () => {
  const known = new Map([
    ['portfolios', new Set(['id', 'name', 'client_id'])],
    ['positions', new Set(['id', 'symbol'])],
  ]);

  it('finds a column the database has and the client does not', () => {
    const stale = staleFrom(
      [
        { table: 'portfolios', column: 'id' },
        { table: 'portfolios', column: 'objective' },
      ],
      known,
    );

    expect(stale).toEqual([{ table: 'portfolios', column: 'objective' }]);
  });

  it('says nothing when the client knows every column', () => {
    expect(
      staleFrom(
        [
          { table: 'portfolios', column: 'id' },
          { table: 'positions', column: 'symbol' },
        ],
        known,
      ),
    ).toEqual([]);
  });

  it('ignores tables the client does not map at all', () => {
    // _prisma_migrations and anything else this application does not own is
    // not evidence of staleness, and refusing to start over one would be a
    // guard that fires on the wrong thing.
    expect(
      staleFrom(
        [
          { table: '_prisma_migrations', column: 'checksum' },
          { table: 'some_other_app', column: 'whatever' },
        ],
        known,
      ),
    ).toEqual([]);
  });

  it('does not report a column the client has and the database lacks', () => {
    // That is a pending migration, which already has its own error. Reporting
    // it here would give two names to one problem.
    expect(staleFrom([{ table: 'portfolios', column: 'id' }], known)).toEqual([]);
  });
});
