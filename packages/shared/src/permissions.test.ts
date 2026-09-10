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

  it('lets a manager trade but not widen risk limits (§40)', () => {
    expect(roleHasPermission(UserRole.MANAGER, Permission.ORDER_WRITE)).toBe(true);
    expect(roleHasPermission(UserRole.MANAGER, Permission.SIGNAL_APPROVE)).toBe(true);
    expect(roleHasPermission(UserRole.MANAGER, Permission.RISK_WRITE)).toBe(false);
  });

  it('lets a manager stop trading but not restart it', () => {
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
