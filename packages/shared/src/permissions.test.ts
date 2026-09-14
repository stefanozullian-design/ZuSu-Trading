import { describe, expect, it } from 'vitest';
import { UserRole } from './enums.js';
import {
  Permission,
  permissionsForRole,
  roleHasPermission,
  roleRequiresMfa,
} from './permissions.js';

describe('role permissions', () => {
  it('gives an administrator every permission', () => {
    for (const permission of Object.values(Permission)) {
      expect(roleHasPermission(UserRole.ADMIN, permission)).toBe(true);
    }
  });

  it('lets a manager trade, and set the limits they trade under', () => {
    // §40 withheld risk:write from a manager, and the owner of this
    // installation moved it. The argument describes a firm, where the person
    // who trades and the person who sets the ceiling are different people; in
    // a one-person install the separation bought a second login rather than a
    // second opinion. What it protected is kept in the change itself — see
    // the risk-limits suite: versioned, reasoned, audited.
    expect(roleHasPermission(UserRole.MANAGER, Permission.ORDER_WRITE)).toBe(true);
    expect(roleHasPermission(UserRole.MANAGER, Permission.SIGNAL_APPROVE)).toBe(true);
    expect(roleHasPermission(UserRole.MANAGER, Permission.RISK_WRITE)).toBe(true);
  });

  it('lets a manager stop trading but not restart it', () => {
    // The asymmetry survives the change above, and is the opposite shape:
    // stopping is safe in every circumstance, restarting is the decision
    // worth a second pair of eyes.
    expect(roleHasPermission(UserRole.MANAGER, Permission.KILL_SWITCH_ACTIVATE)).toBe(true);
    expect(roleHasPermission(UserRole.MANAGER, Permission.KILL_SWITCH_RELEASE)).toBe(false);
  });

  it('keeps clients and viewers read-only', () => {
    for (const role of [UserRole.CLIENT, UserRole.VIEWER]) {
      for (const permission of [
        Permission.ORDER_WRITE,
        Permission.PORTFOLIO_WRITE,
        Permission.STRATEGY_WRITE,
        Permission.RISK_WRITE,
        Permission.SIGNAL_APPROVE,
        Permission.KILL_SWITCH_ACTIVATE,
        Permission.CLIENT_READ,
        Permission.AUDIT_READ,
        Permission.USER_WRITE,
        Permission.BROKER_ACCOUNT_READ,
      ]) {
        expect(roleHasPermission(role, permission)).toBe(false);
      }
    }
  });

  it('gives a viewer strictly less than a client', () => {
    const viewer = permissionsForRole(UserRole.VIEWER);
    const client = permissionsForRole(UserRole.CLIENT);
    expect(viewer.length).toBeLessThan(client.length);
    for (const permission of viewer) expect(client).toContain(permission);
  });

  it('never exposes broker credentials to a non-administrator', () => {
    for (const role of [UserRole.MANAGER, UserRole.CLIENT, UserRole.VIEWER]) {
      expect(roleHasPermission(role, Permission.BROKER_ACCOUNT_WRITE)).toBe(false);
    }
  });

  it('requires a second factor of administrators only', () => {
    expect(roleRequiresMfa(UserRole.ADMIN)).toBe(true);
    expect(roleRequiresMfa(UserRole.MANAGER)).toBe(false);
  });
});

/**
 * Who may say whose money is under management.
 *
 * A manager may register and edit owners: in the installation this platform is
 * actually used in, the person who trades and the person who decides whose
 * money is here are the same person, and requiring a second login with an
 * authenticator app to add a relative bought nothing. What the old separation
 * protected survives elsewhere — every change is audited with both sides, and
 * owners are retired rather than deleted.
 *
 * The genuinely dangerous permissions stay where they were, and this test
 * exists so that widening one never quietly widens the others.
 */
describe('managing owners', () => {
  it('lets a manager register and edit owners', () => {
    expect(roleHasPermission(UserRole.MANAGER, Permission.CLIENT_WRITE)).toBe(true);
    expect(roleHasPermission(UserRole.ADMIN, Permission.CLIENT_WRITE)).toBe(true);
  });

  it('still withholds it from everyone who only reads', () => {
    for (const role of [UserRole.CLIENT, UserRole.VIEWER]) {
      expect(roleHasPermission(role, Permission.CLIENT_WRITE), role).toBe(false);
    }
  });

  it('leaves the permissions that matter most exactly where they were', () => {
    for (const permission of [
      Permission.STRATEGY_PROMOTE,
      Permission.KILL_SWITCH_RELEASE,
      Permission.AUDIT_READ,
      Permission.USER_WRITE,
    ]) {
      expect(roleHasPermission(UserRole.MANAGER, permission), permission).toBe(false);
      expect(roleHasPermission(UserRole.ADMIN, permission), permission).toBe(true);
    }
  });
});
