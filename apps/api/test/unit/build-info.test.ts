import { describe, expect, it } from 'vitest';
import { buildInfo, buildInfoFrom } from '../../src/lib/build-info.js';

/**
 * Which commit is running.
 *
 * The whole value of this is that it cannot be wrong, so the tests are about
 * the two ways it could be: inventing a version where there is none, and
 * naming a commit whose code is not actually what is running.
 */

describe('buildInfoFrom', () => {
  it('reports the commit and when it was made', () => {
    expect(buildInfoFrom('3a64949', '2026-09-13T18:22:10+00:00', '')).toEqual({
      commit: '3a64949',
      committedAt: '2026-09-13T18:22:10+00:00',
      modified: false,
    });
  });

  it('marks a checkout whose tracked files have been changed', () => {
    // The commit named is then not the whole truth about what is running, and
    // showing the hash alone would be the lie this exists to prevent.
    expect(buildInfoFrom('3a64949', null, ' M apps/web/src/App.tsx').modified).toBe(true);
  });

  it('says nothing rather than inventing a version outside a checkout', () => {
    for (const absent of [null, '', '   ']) {
      expect(buildInfoFrom(absent, '2026-01-01T00:00:00Z', ' M something')).toEqual({
        commit: null,
        committedAt: null,
        modified: false,
      });
    }
  });

  it('treats an empty commit date as unknown rather than as an empty string', () => {
    expect(buildInfoFrom('abc1234', '', '').committedAt).toBeNull();
  });
});

describe('buildInfo', () => {
  it('reads the repository it is running from', () => {
    const info = buildInfo();

    // This suite runs inside the checkout, so there is a commit to find. A
    // null here would mean the path back to the repository root is wrong —
    // which would silently turn the badge into "version unknown" forever.
    expect(info.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(info.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('answers the same way twice, without asking git again', () => {
    expect(buildInfo()).toBe(buildInfo());
  });
});
