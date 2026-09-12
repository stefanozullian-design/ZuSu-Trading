/**
 * Seed / demo data (§15, §74).
 *
 * Creates a fully explorable DEMO deployment: four users covering every role,
 * a client, a $100,000 demo portfolio with open positions, three preconfigured
 * strategy definitions and a watchlist — all without a single API credential.
 *
 * Safe to re-run: every write is keyed on a natural identifier.
 */
import { PrismaClient } from '@prisma/client';
import { AuditAction } from '@zusu/shared';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { hashPassword } from '../src/lib/crypto.js';
import { DEMO_UNIVERSE, MarketSimulator } from '../src/modules/broker/market-simulator.js';

const db = new PrismaClient();
const audit = new AuditService(db);

/** Demo credentials. Printed on completion; obviously not for production use. */
const DEMO_PASSWORD = 'DemoTrading2026!';

const SECTORS: Record<string, { sector: string; industry: string; beta: number }> = {
  AAPL: { sector: 'Technology', industry: 'Consumer Electronics', beta: 1.21 },
  MSFT: { sector: 'Technology', industry: 'Software', beta: 0.94 },
  NVDA: { sector: 'Technology', industry: 'Semiconductors', beta: 1.72 },
  AMD: { sector: 'Technology', industry: 'Semiconductors', beta: 1.68 },
  TSLA: { sector: 'Consumer Cyclical', industry: 'Auto Manufacturers', beta: 2.11 },
  SPY: { sector: 'Index', industry: 'Broad Market ETF', beta: 1.0 },
  QQQ: { sector: 'Index', industry: 'Technology ETF', beta: 1.14 },
  IWM: { sector: 'Index', industry: 'Small Cap ETF', beta: 1.09 },
};

async function main(): Promise<void> {
  console.log('Seeding ZuSu Trading demo data…');

  await seedComplianceDocuments();
  const instruments = await seedInstruments();
  const client = await seedClient();
  const users = await seedUsers(client.id);
  const portfolio = await seedPortfolio(client.id, users.admin.id);
  await grantAccess(portfolio.id, users);
  await seedPositions(portfolio.id);
  await seedHistory(portfolio.id);
  await seedWatchlist(portfolio.id, instruments);
  await seedStrategies(users.admin.id);
  await seedAutomationConfigs(portfolio.id);

  await audit.record({
    action: AuditAction.PORTFOLIO_MODIFIED,
    actorType: 'SYSTEM',
    actorLabel: 'seed',
    entityType: 'Portfolio',
    entityId: portfolio.id,
    portfolioId: portfolio.id,
    environment: 'DEMO',
    metadata: { note: 'demo data seeded' },
  });

  console.log(`
Demo data ready.

  Sign in at the web client with any of:

    admin@zusu.local     ${DEMO_PASSWORD}   (ADMIN — must enrol MFA on first sign-in)
    manager@zusu.local   ${DEMO_PASSWORD}   (MANAGER — can trade, cannot change risk limits)
    client@zusu.local    ${DEMO_PASSWORD}   (CLIENT — read-only, one portfolio)
    viewer@zusu.local    ${DEMO_PASSWORD}   (VIEWER — limited read-only)

  Portfolio: "${portfolio.name}" (DEMO, $100,000)
`);
}

async function seedComplianceDocuments(): Promise<void> {
  const documents = [
    {
      type: 'RISK_DISCLOSURE' as const,
      title: 'Trading risk disclosure',
      body:
        'Trading securities involves substantial risk of loss and is not suitable for every ' +
        'investor. Automated strategies can lose money rapidly. Past performance, including ' +
        'backtested or simulated performance, does not indicate future results. The operator of ' +
        'this system is responsible for determining which regulatory framework applies to their ' +
        'activity and for obtaining qualified legal and compliance advice.',
    },
    {
      type: 'TERMS_OF_USE' as const,
      title: 'Terms of use',
      body:
        'This software is provided as a tool. It makes no representation that any strategy is ' +
        'suitable for any person, and it is not investment advice.',
    },
    {
      type: 'PRIVACY_POLICY' as const,
      title: 'Privacy policy',
      body:
        'Account data, trading records and audit logs are retained for the period the operator ' +
        'configures. Broker credentials are stored encrypted and are never exposed to the web client.',
    },
  ];

  for (const doc of documents) {
    await db.complianceDocument.upsert({
      where: { type_version: { type: doc.type, version: 1 } },
      update: {},
      create: { ...doc, version: 1, isActive: true },
    });
  }
}

async function seedInstruments() {
  const created = [];
  for (const instrument of DEMO_UNIVERSE) {
    const meta = SECTORS[instrument.symbol];
    created.push(
      await db.instrument.upsert({
        where: { symbol: instrument.symbol },
        update: {},
        create: {
          symbol: instrument.symbol,
          name: instrument.symbol,
          assetClass: ['SPY', 'QQQ', 'IWM'].includes(instrument.symbol) ? 'ETF' : 'EQUITY',
          exchange: 'DEMO',
          sector: meta?.sector ?? null,
          industry: meta?.industry ?? null,
          beta: meta?.beta ?? null,
        },
      }),
    );
  }
  return created;
}

async function seedClient() {
  return db.client.upsert({
    where: { externalRef: 'DEMO-CLIENT-001' },
    update: {},
    create: {
      name: 'Demo Client — Alice Nakamura',
      externalRef: 'DEMO-CLIENT-001',
      contactEmail: 'client@zusu.local',
      notes: 'Seeded demo client. Not a real person.',
    },
  });
}

async function seedUsers(clientId: string) {
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const upsert = (
    email: string,
    displayName: string,
    role: 'ADMIN' | 'MANAGER' | 'CLIENT' | 'VIEWER',
    linkClient: boolean,
  ) =>
    db.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        displayName,
        passwordHash,
        role,
        clientId: linkClient ? clientId : null,
      },
    });

  return {
    admin: await upsert('admin@zusu.local', 'Demo Administrator', 'ADMIN', false),
    manager: await upsert('manager@zusu.local', 'Demo Manager', 'MANAGER', false),
    client: await upsert('client@zusu.local', 'Alice Nakamura', 'CLIENT', true),
    viewer: await upsert('viewer@zusu.local', 'Demo Viewer', 'VIEWER', false),
  };
}

async function seedPortfolio(clientId: string, adminId: string) {
  const existing = await db.portfolio.findUnique({
    where: { name_environment: { name: 'Demo Portfolio', environment: 'DEMO' } },
  });
  if (existing) return existing;

  const portfolio = await db.portfolio.create({
    data: {
      name: 'Demo Portfolio',
      environment: 'DEMO',
      clientId,
      baseCurrency: 'USD',
      initialCapital: '100000',
      // Starting cash after the seeded positions were bought (see seedPositions).
      cashBalance: '61458.30',
      executionMode: 'MANUAL_APPROVAL',
    },
  });

  await db.clientPortfolio.create({
    data: { clientId, portfolioId: portfolio.id, isPrimary: true },
  });

  // The simulated venue is a broker, so the demo portfolio has a broker account
  // like any other. Without one there is nowhere to store a reconciliation, and
  // the system-health panel would report "never run" straight after someone had
  // run one — two screens disagreeing about the same fact.
  await db.brokerAccount.create({
    data: {
      portfolioId: portfolio.id,
      environment: 'DEMO',
      broker: 'DEMO',
      label: 'Simulated venue',
      connectionState: 'CONNECTED',
      lastConnectedAt: new Date(),
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
      changedById: adminId,
      changeReason: 'Seeded defaults',
    },
  });

  await db.cashFlow.create({
    data: {
      portfolioId: portfolio.id,
      type: 'DEPOSIT',
      amount: '100000',
      occurredAt: daysAgo(30),
      note: 'Opening deposit',
    },
  });

  return portfolio;
}

async function grantAccess(
  portfolioId: string,
  users: { manager: { id: string }; viewer: { id: string } },
): Promise<void> {
  await db.portfolioAccess.upsert({
    where: { userId_portfolioId: { userId: users.manager.id, portfolioId } },
    update: {},
    create: { userId: users.manager.id, portfolioId, canTrade: true },
  });
  await db.portfolioAccess.upsert({
    where: { userId_portfolioId: { userId: users.viewer.id, portfolioId } },
    update: {},
    create: { userId: users.viewer.id, portfolioId, canTrade: false },
  });
}

async function seedPositions(portfolioId: string): Promise<void> {
  if ((await db.position.count({ where: { portfolioId } })) > 0) return;

  // Entry prices are the simulator's own prices from a few days ago, so the
  // unrealised P&L the dashboard shows is consistent with the demo market.
  const simulator = new MarketSimulator({ seed: Number(process.env.DEMO_SEED ?? 20260101) });
  const openedAt = daysAgo(3);
  const holdings: Array<{ symbol: string; quantity: string }> = [
    { symbol: 'AAPL', quantity: '60' },
    { symbol: 'MSFT', quantity: '25' },
    { symbol: 'NVDA', quantity: '120' },
    { symbol: 'SPY', quantity: '15' },
  ];

  for (const holding of holdings) {
    const entry = simulator.priceAt(holding.symbol, openedAt.getTime());
    const position = await db.position.create({
      data: {
        portfolioId,
        symbol: holding.symbol,
        assetClass: holding.symbol === 'SPY' ? 'ETF' : 'EQUITY',
        status: 'OPEN',
        quantity: holding.quantity,
        averageEntryPrice: entry.toFixed(8),
        openedAt,
      },
    });
    await db.positionLot.create({
      data: {
        positionId: position.id,
        quantity: holding.quantity,
        remainingQty: holding.quantity,
        costBasis: entry.times(holding.quantity).toFixed(8),
        openedAt,
      },
    });
  }
}

/** A short snapshot history so the dashboard can show a real daily P&L. */
async function seedHistory(portfolioId: string): Promise<void> {
  if ((await db.portfolioSnapshot.count({ where: { portfolioId } })) > 0) return;

  const simulator = new MarketSimulator({ seed: Number(process.env.DEMO_SEED ?? 20260101) });
  const holdings: Array<[string, number]> = [
    ['AAPL', 60],
    ['MSFT', 25],
    ['NVDA', 120],
    ['SPY', 15],
  ];

  for (let daysBack = 5; daysBack >= 1; daysBack -= 1) {
    const asOf = daysAgo(daysBack);
    const positionsValue = holdings.reduce(
      (sum, [symbol, qty]) => sum + simulator.priceAt(symbol, asOf.getTime()).toNumber() * qty,
      0,
    );
    const cash = 61458.3;
    await db.portfolioSnapshot.create({
      data: {
        portfolioId,
        asOf,
        cashBalance: cash.toFixed(8),
        positionsValue: positionsValue.toFixed(8),
        equity: (cash + positionsValue).toFixed(8),
        openPositions: holdings.length,
      },
    });
  }
}

async function seedWatchlist(portfolioId: string, instruments: { id: string }[]): Promise<void> {
  const existing = await db.watchlist.findFirst({ where: { portfolioId, name: 'Demo Watchlist' } });
  if (existing) return;

  const watchlist = await db.watchlist.create({
    data: { portfolioId, name: 'Demo Watchlist', description: 'The demo simulator universe' },
  });
  for (const instrument of instruments) {
    await db.watchlistItem.create({
      data: { watchlistId: watchlist.id, instrumentId: instrument.id },
    });
  }
}

/**
 * Preconfigured strategy definitions (§74).
 *
 * These are written in the real rule language — the same nested AND/OR/NOT
 * records the strategy engine evaluates — and every field they reference is
 * one the indicator engine actually computes. An earlier version of this seed
 * invented a plausible-looking shape instead, which meant the shipped examples
 * could not be read, evaluated, or promoted: demo data the product cannot use
 * is fiction, not a demo.
 *
 * They are left at DRAFT. Nothing here pretends to be running.
 */
async function seedStrategies(authorId: string): Promise<void> {
  const strategies = [
    {
      name: 'RSI Oversold Bounce',
      description: 'Buys oversold pullbacks that are still above the 50-period average.',
      definition: {
        timeframe: '5m',
        watchlistId: null,
        entry: {
          direction: 'LONG',
          when: {
            type: 'all',
            children: [
              { type: 'condition', field: 'rsi14', operator: 'lt', operand: { constant: '30' } },
              { type: 'condition', field: 'close', operator: 'gt', operand: { field: 'sma50' } },
              {
                type: 'any',
                children: [
                  {
                    type: 'condition',
                    field: 'close',
                    operator: 'crosses_above',
                    operand: { field: 'vwap' },
                  },
                  {
                    type: 'condition',
                    field: 'stochasticK',
                    operator: 'crosses_above',
                    operand: { field: 'stochasticD' },
                  },
                ],
              },
            ],
          },
        },
        exit: {
          when: { type: 'condition', field: 'rsi14', operator: 'gt', operand: { constant: '65' } },
        },
        stop: { kind: 'PERCENT', value: '2' },
        target: { kind: 'RISK_MULTIPLE', value: '2.4' },
      },
      riskSettings: { maxConcurrentPositions: 3, maxNotionalPerTrade: '5000', minBars: 60 },
    },
    {
      name: 'MACD Crossover',
      description: 'Enters on a MACD signal-line crossover while price holds its fast average.',
      definition: {
        timeframe: '5m',
        watchlistId: null,
        entry: {
          direction: 'LONG',
          when: {
            type: 'all',
            children: [
              {
                type: 'condition',
                field: 'macd',
                operator: 'crosses_above',
                operand: { field: 'macdSignal' },
              },
              { type: 'condition', field: 'close', operator: 'gt', operand: { field: 'ema12' } },
            ],
          },
        },
        exit: {
          when: {
            type: 'condition',
            field: 'macd',
            operator: 'crosses_below',
            operand: { field: 'macdSignal' },
          },
        },
        stop: { kind: 'ATR', value: '1.5' },
        target: { kind: 'ATR', value: '3' },
      },
      riskSettings: { maxConcurrentPositions: 2, maxNotionalPerTrade: '4000', minBars: 80 },
    },
    {
      name: 'Bollinger Reversion',
      description: 'Fades a stretch below the lower band once momentum stops falling.',
      definition: {
        timeframe: '5m',
        watchlistId: null,
        entry: {
          direction: 'LONG',
          when: {
            type: 'all',
            children: [
              {
                type: 'condition',
                field: 'close',
                operator: 'crosses_above',
                operand: { field: 'bollingerLower' },
              },
              {
                type: 'condition',
                field: 'rsi14',
                operator: 'between',
                operand: { constant: '25' },
                operandUpper: { constant: '45' },
              },
              {
                type: 'not',
                child: {
                  type: 'condition',
                  field: 'close',
                  operator: 'gt',
                  operand: { field: 'bollingerMiddle' },
                },
              },
            ],
          },
        },
        exit: {
          when: {
            type: 'condition',
            field: 'close',
            operator: 'gte',
            operand: { field: 'bollingerMiddle' },
          },
        },
        stop: { kind: 'PERCENT', value: '1.5' },
        target: { kind: 'PERCENT', value: '2.5' },
      },
      riskSettings: { maxConcurrentPositions: 2, maxNotionalPerTrade: '4000', minBars: 60 },
      allowedRegimes: ['RANGING', 'HIGH_VOLATILITY'],
    },
  ];

  for (const spec of strategies) {
    const existing = await db.strategy.findUnique({ where: { name: spec.name } });
    if (existing) continue;

    const strategy = await db.strategy.create({
      data: { name: spec.name, description: spec.description },
    });
    await db.strategyVersion.create({
      data: {
        strategyId: strategy.id,
        version: 1,
        stage: 'DRAFT',
        authorId,
        changeDescription: 'Seeded demo strategy definition',
        definition: spec.definition,
        riskSettings: spec.riskSettings,
        allowedRegimes: spec.allowedRegimes ?? undefined,
        sessionScope: 'REGULAR_ONLY',
      },
    });
  }
}

/**
 * Pairs each seeded strategy with the demo portfolio, at MANUAL_APPROVAL.
 *
 * That is the rung the platform ships on and the only one that is not a
 * decision: every order waits for a person. Seeding anything automatic would
 * mean a fresh install could trade before its owner had read a single screen.
 */
async function seedAutomationConfigs(portfolioId: string): Promise<void> {
  const strategies = await db.strategy.findMany({
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });

  for (const strategy of strategies) {
    const version = strategy.versions[0];
    if (!version) continue;
    const existing = await db.strategyPortfolioConfig.findUnique({
      where: { portfolioId_strategyId: { portfolioId, strategyId: strategy.id } },
    });
    if (existing) continue;

    await db.strategyPortfolioConfig.create({
      data: {
        strategyId: strategy.id,
        strategyVersionId: version.id,
        portfolioId,
        isEnabled: false,
        executionMode: 'MANUAL_APPROVAL',
        positionSizing: { method: 'FIXED_FRACTIONAL', riskPerTradePct: '1' },
      },
    });
  }
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(20, 0, 0, 0);
  return d;
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
