import { describe, expect, it } from 'vitest';
import { PendingMigrationsError, pendingFrom } from '../../src/lib/migration-check.js';

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
