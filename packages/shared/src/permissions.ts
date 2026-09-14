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
  /**
   * Reading quotes, candles, indicators and the market calendar. Reference
   * data rather than tenant data — it is not scoped to a client, so every
   * authenticated role has it.
   */
  MARKET_DATA_READ: 'market_data:read',
  /**
   * Creating and editing watchlists and saved scans. Withheld from VIEWER and
   * CLIENT: both may read market data, neither configures the platform.
   */
  WATCHLIST_WRITE: 'watchlist:write',
  /** Reading configured risk limits. */
  RISK_READ: 'risk:read',
  /**
   * Changing risk limits.
   *
   * Withheld from MANAGER until the owner of this installation decided
   * otherwise (spec §40 said administrator-only). The argument for the
   * separation is real — an account that can raise its own limits has limits
   * in name only — and it describes a firm, where the person who trades and
   * the person who sets the ceiling are different people. In a one-person
   * install they are the same person, and the separation bought a second
   * login with an authenticator app rather than a second opinion.
   *
   * What the boundary was protecting is kept where it can be: every change
   * writes a new version rather than editing the one in force, the previous
   * numbers stay readable, a reason is required, and both sides go into the
   * audit log. A limit can be raised, and never quietly.
   */
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
  Permission.MARKET_DATA_READ,
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
  Permission.WATCHLIST_WRITE,
  Permission.CLIENT_READ,
  /**
   * Registering and editing the people whose money is under management.
   *
   * Withheld from managers until now, on the reasoning that someone able to
   * invent an owner could quietly move a book to one. That separation is real
   * in a firm, where the person who trades and the person who decides whose
   * money is here are different people. It is not real in the installation
   * this platform is actually used in, where both are the same person and the
   * only effect was that adding a relative required a second login with an
   * authenticator app.
   *
   * What the boundary was protecting is not lost: every create and every edit
   * is audited with both sides, owners are retired rather than deleted, and
   * moving a portfolio between owners was always a manager's action anyway —
   * so a manager who wanted to misfile a book never needed this permission to
   * do it.
   */
  Permission.CLIENT_WRITE,
  Permission.PORTFOLIO_WRITE,
  Permission.BROKER_ACCOUNT_READ,
  Permission.STRATEGY_WRITE,
  Permission.SIGNAL_APPROVE,
  Permission.ORDER_WRITE,
  Permission.BACKTEST_READ,
  Permission.BACKTEST_WRITE,
  /**
   * Changing risk limits. See the note on RISK_WRITE for why this moved.
   *
   * A manager can still only *stop* trading: releasing a halt remains
   * administrator-only, and that asymmetry is deliberate. Stopping is safe in
   * every circumstance and restarting is the decision worth a second pair of
   * eyes, which is the opposite shape from a limit somebody has to be able to
   * correct after importing their holdings.
   */
  Permission.RISK_WRITE,
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
