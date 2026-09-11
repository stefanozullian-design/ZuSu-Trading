import { UserRole } from './enums.js';

/**
 * Fine-grained permissions. Roles are convenience bundles; every backend route
 * asserts a *permission*, never a role name, so adding a role never silently
 * widens access.
 */
export const Permission = {
  USER_READ: 'user:read',
  USER_WRITE: 'user:write',
  CLIENT_READ: 'client:read',
  CLIENT_WRITE: 'client:write',
  PORTFOLIO_READ: 'portfolio:read',
  PORTFOLIO_WRITE: 'portfolio:write',
  BROKER_ACCOUNT_READ: 'broker_account:read',
  BROKER_ACCOUNT_WRITE: 'broker_account:write',
  STRATEGY_READ: 'strategy:read',
  STRATEGY_WRITE: 'strategy:write',
  STRATEGY_PROMOTE: 'strategy:promote',
  SIGNAL_READ: 'signal:read',
  SIGNAL_APPROVE: 'signal:approve',
  ORDER_READ: 'order:read',
  ORDER_WRITE: 'order:write',
  POSITION_READ: 'position:read',
  /** Reading configured risk limits. */
  RISK_READ: 'risk:read',
  /** Changing risk limits — deliberately withheld from MANAGER (spec §40). */
  RISK_WRITE: 'risk:write',
  KILL_SWITCH_ACTIVATE: 'kill_switch:activate',
  KILL_SWITCH_RELEASE: 'kill_switch:release',
  BACKTEST_READ: 'backtest:read',
  BACKTEST_WRITE: 'backtest:write',
  PERFORMANCE_READ: 'performance:read',
  REPORT_READ: 'report:read',
  AUDIT_READ: 'audit:read',
  SYSTEM_READ: 'system:read',
  SYSTEM_WRITE: 'system:write',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

const VIEWER_PERMISSIONS: Permission[] = [
  Permission.PORTFOLIO_READ,
  Permission.POSITION_READ,
  Permission.PERFORMANCE_READ,
];

const CLIENT_PERMISSIONS: Permission[] = [
  ...VIEWER_PERMISSIONS,
  Permission.ORDER_READ,
  Permission.SIGNAL_READ,
  Permission.RISK_READ,
  Permission.REPORT_READ,
  Permission.STRATEGY_READ,
];

const MANAGER_PERMISSIONS: Permission[] = [
  ...CLIENT_PERMISSIONS,
  Permission.CLIENT_READ,
  Permission.PORTFOLIO_WRITE,
  Permission.BROKER_ACCOUNT_READ,
  Permission.STRATEGY_WRITE,
  Permission.SIGNAL_APPROVE,
  Permission.ORDER_WRITE,
  Permission.BACKTEST_READ,
  Permission.BACKTEST_WRITE,
  // A manager can always stop trading, but cannot release the halt or widen
  // risk limits — that requires an admin.
  Permission.KILL_SWITCH_ACTIVATE,
  Permission.SYSTEM_READ,
];

const ADMIN_PERMISSIONS: Permission[] = Object.values(Permission);

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = Object.freeze({
  [UserRole.ADMIN]: Object.freeze(ADMIN_PERMISSIONS),
  [UserRole.MANAGER]: Object.freeze(MANAGER_PERMISSIONS),
  [UserRole.CLIENT]: Object.freeze(CLIENT_PERMISSIONS),
  [UserRole.VIEWER]: Object.freeze(VIEWER_PERMISSIONS),
});

export function permissionsForRole(role: UserRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/** Roles that must complete an MFA challenge before a session is issued (§52). */
export const MFA_REQUIRED_ROLES: readonly UserRole[] = Object.freeze([UserRole.ADMIN]);

export function roleRequiresMfa(role: UserRole): boolean {
  return MFA_REQUIRED_ROLES.includes(role);
}
