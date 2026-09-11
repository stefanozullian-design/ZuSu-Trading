import type { Portfolio, PrismaClient, User } from '@prisma/client';
import type { UserRole } from '@zusu/shared';
import { hashPassword } from '../../src/lib/crypto.js';

export const TEST_PASSWORD = 'TestPassword123!';

let passwordHashCache: string | null = null;

async function cachedHash(): Promise<string> {
  // scrypt is intentionally slow; hashing the shared fixture password once
  // keeps the integration suite from spending its whole budget on KDF work.
  passwordHashCache ??= await hashPassword(TEST_PASSWORD);
  return passwordHashCache;
}

export async function createUser(
  db: PrismaClient,
  options: {
    email: string;
    role: UserRole;
    clientId?: string | null;
    mfaEnabled?: boolean;
    mfaSecret?: string | null;
    isActive?: boolean;
  },
): Promise<User> {
  return db.user.create({
    data: {
      email: options.email,
      displayName: options.email.split('@')[0] ?? options.email,
      passwordHash: await cachedHash(),
      role: options.role,
      clientId: options.clientId ?? null,
      mfaEnabled: options.mfaEnabled ?? false,
      mfaSecret: options.mfaSecret ?? null,
      isActive: options.isActive ?? true,
    },
  });
}

export async function createClient(db: PrismaClient, name: string) {
  return db.client.create({ data: { name } });
}

export async function createPortfolio(
  db: PrismaClient,
  options: {
    name: string;
    clientId?: string | null;
    environment?: 'DEMO' | 'PAPER' | 'LIVE';
    initialCapital?: string;
  },
): Promise<Portfolio> {
  const portfolio = await db.portfolio.create({
    data: {
      name: options.name,
      environment: options.environment ?? 'DEMO',
      clientId: options.clientId ?? null,
      initialCapital: options.initialCapital ?? '100000',
      cashBalance: options.initialCapital ?? '100000',
    },
  });

  await db.riskLimit.create({
    data: {
      portfolioId: portfolio.id,
      version: 1,
      isActive: true,
      maxDailyLoss: '2000',
      maxWeeklyLoss: '5000',
      maxPositionSize: '10000',
      maxPortfolioExposurePct: '60',
      maxSectorExposurePct: '30',
      maxSymbolExposurePct: '15',
      maxOpenPositions: 10,
      maxTradesPerDay: 20,
      maxConsecutiveLosses: 4,
      maxDrawdownPct: '15',
    },
  });

  if (options.clientId) {
    await db.clientPortfolio.create({
      data: { clientId: options.clientId, portfolioId: portfolio.id, isPrimary: true },
    });
  }

  return portfolio;
}

export async function grantPortfolioAccess(
  db: PrismaClient,
  userId: string,
  portfolioId: string,
  canTrade = false,
): Promise<void> {
  await db.portfolioAccess.create({ data: { userId, portfolioId, canTrade } });
}
