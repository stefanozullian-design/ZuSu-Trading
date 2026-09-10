import type { Portfolio, Prisma, PrismaClient, User } from '@prisma/client';
import { AuditAction, Permission, UserRole, roleHasPermission } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import type { AuditService } from '../audit/audit.service.js';

export type Principal = Pick<User, 'id' | 'role' | 'clientId' | 'email' | 'isActive'>;

/**
 * The single authorization choke point.
 *
 * Every portfolio-scoped read composes `portfolioScope()` into its `where`
 * clause and every portfolio-scoped write calls `assertPortfolioAccess()`.
 * Nothing else in the codebase is permitted to decide who may see what, which
 * is what makes the isolation tests meaningful (§41).
 */
export class AccessControl {
  constructor(
    private readonly db: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  assertPermission(principal: Principal, permission: Permission): void {
    if (!roleHasPermission(principal.role as UserRole, permission)) {
      throw new AppError(
        'FORBIDDEN',
        `Your role (${principal.role}) does not include the "${permission}" permission`,
      );
    }
  }

  /**
   * A Prisma filter matching exactly the portfolios this principal may read.
   * Admins get an empty filter (everything); everyone else gets explicit grants
   * plus the portfolios of the client they belong to.
   */
  portfolioScope(principal: Principal): Prisma.PortfolioWhereInput {
    if (principal.role === UserRole.ADMIN) return {};

    const clauses: Prisma.PortfolioWhereInput[] = [{ access: { some: { userId: principal.id } } }];
    if (principal.clientId) {
      clauses.push({ clientId: principal.clientId });
      clauses.push({ clientPortfolios: { some: { clientId: principal.clientId } } });
    }
    return { OR: clauses };
  }

  /** The same restriction expressed for tables that carry a `portfolioId`. */
  portfolioIdScope(principal: Principal): Prisma.PortfolioWhereInput | undefined {
    return principal.role === UserRole.ADMIN ? undefined : this.portfolioScope(principal);
  }

  async listAccessiblePortfolioIds(principal: Principal): Promise<string[]> {
    const rows = await this.db.portfolio.findMany({
      where: this.portfolioScope(principal),
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Resolves a portfolio the principal is allowed to touch, or throws.
   *
   * A denied attempt is audited: attempts to reach another client's data are
   * exactly the events an operator needs to see.
   */
  async assertPortfolioAccess(
    principal: Principal,
    portfolioId: string,
    options: { permission: Permission; requireTrade?: boolean } = {
      permission: Permission.PORTFOLIO_READ,
    },
  ): Promise<Portfolio> {
    this.assertPermission(principal, options.permission);

    const portfolio = await this.db.portfolio.findFirst({
      where: { AND: [{ id: portfolioId }, this.portfolioScope(principal)] },
    });

    if (!portfolio) {
      // Distinguishing "does not exist" from "not yours" would leak the
      // existence of other clients' portfolios, so both return 404.
      const exists = await this.db.portfolio.count({ where: { id: portfolioId } });
      if (exists > 0) {
        await this.audit.recordSafe({
          action: AuditAction.PORTFOLIO_ACCESS_DENIED,
          actorUserId: principal.id,
          entityType: 'Portfolio',
          entityId: portfolioId,
          portfolioId,
          metadata: { role: principal.role, permission: options.permission },
        });
      }
      throw new AppError('NOT_FOUND', 'Portfolio not found');
    }

    if (options.requireTrade && principal.role !== UserRole.ADMIN) {
      const grant = await this.db.portfolioAccess.findUnique({
        where: { userId_portfolioId: { userId: principal.id, portfolioId } },
        select: { canTrade: true },
      });
      if (!grant?.canTrade) {
        throw new AppError('FORBIDDEN', 'You do not have trading rights on this portfolio');
      }
    }

    return portfolio;
  }
}
