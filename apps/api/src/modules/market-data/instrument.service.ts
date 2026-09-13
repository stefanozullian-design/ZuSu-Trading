import type { PrismaClient } from '@prisma/client';
import { AuditAction, Permission } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';
import type { MarketDataProviderRegistry } from './provider-registry.js';
import type { MarketDataSyncService } from './market-data-sync.service.js';

export interface InstrumentDto {
  symbol: string;
  name: string | null;
  assetClass: string;
  exchange: string | null;
  sector: string | null;
  isTradable: boolean;
  /** Bars already stored for it, so a caller can tell a chartable symbol apart. */
  candleCount: number;
}

/**
 * The symbols this platform knows about.
 *
 * Until now the only instruments that existed were the eight the demo seed
 * writes, and nothing in the application could add a ninth — not the import,
 * not a watchlist, which requires a known instrument too. So an installation
 * with a real market-data feed could still only hold AAPL and seven others,
 * and the import's advice to "add it to a watchlist first" described a route
 * that did not exist.
 *
 * A symbol is added by asking the provider about it, never by writing down
 * whatever somebody typed. An instrument this platform cannot price is worse
 * than an absent one: it would chart as a gap, mark as a dash, and fail every
 * risk check with an explanation about missing data rather than about a
 * symbol that was never real.
 */
export class InstrumentService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
    private readonly audit: AuditService,
    private readonly providers: MarketDataProviderRegistry,
    private readonly sync: MarketDataSyncService,
  ) {}

  /** What the provider knows by this name, for a person to choose from. */
  async search(principal: Principal, query: string): Promise<InstrumentDto[]> {
    this.access.assertPermission(principal, Permission.MARKET_DATA_READ);

    const provider = this.providers.tryResolve();
    if (!provider) {
      throw new AppError(
        'SERVICE_DEGRADED',
        'This installation has no market-data provider, so there is nothing to look a symbol ' +
          'up in. Set MARKET_DATA_PROVIDER and its key.',
      );
    }

    const found = await provider.searchInstruments(query.trim(), 10);
    return found.map((instrument) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      assetClass: instrument.assetClass,
      exchange: instrument.marketCode,
      sector: instrument.sector,
      isTradable: instrument.isActive,
      candleCount: 0,
    }));
  }

  /**
   * Adds a symbol, after the provider confirms it exists.
   *
   * History is fetched in the same breath. A symbol with no bars is not
   * chartable, not markable and not tradable by a paper portfolio, so adding
   * one without them would produce an instrument that exists and does nothing
   * — and the reason would look like a data-quality problem rather than a
   * missing step.
   */
  async add(
    principal: Principal,
    symbol: string,
    options: { days?: number } = {},
  ): Promise<InstrumentDto> {
    this.access.assertPermission(principal, Permission.WATCHLIST_WRITE);

    const normalised = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,12}$/.test(normalised)) {
      throw new AppError('VALIDATION_FAILED', `"${symbol}" is not the shape of a ticker.`);
    }

    const existing = await this.db.instrument.findUnique({ where: { symbol: normalised } });
    if (existing) {
      throw new AppError('CONFLICT', `${normalised} is already known to this platform.`);
    }

    const provider = this.providers.tryResolve();
    if (!provider) {
      throw new AppError(
        'SERVICE_DEGRADED',
        'This installation has no market-data provider, so a symbol cannot be verified. ' +
          'An instrument nobody can price is worse than an absent one.',
      );
    }

    const matches = await provider.searchInstruments(normalised, 10);
    const match = matches.find((candidate) => candidate.symbol.toUpperCase() === normalised);
    if (!match) {
      // Named rather than generic: "not found" invites a retry, and the useful
      // information is that the provider — not this platform — has no such
      // symbol.
      throw new AppError(
        'NOT_FOUND',
        `${provider.name} has no instrument called ${normalised}. Check the ticker: it may be ` +
          'listed elsewhere, or under another symbol.',
      );
    }

    const created = await this.db.$transaction(async (tx) => {
      const instrument = await tx.instrument.create({
        data: {
          symbol: match.symbol.toUpperCase(),
          name: match.name,
          assetClass: match.assetClass,
          exchange: match.marketCode,
          sector: match.sector,
          isTradable: match.isActive,
        },
      });

      await this.audit.record(
        {
          action: AuditAction.INSTRUMENT_ADDED,
          actorUserId: principal.id,
          entityType: 'Instrument',
          entityId: instrument.id,
          after: { symbol: instrument.symbol, name: instrument.name, source: provider.name },
        },
        tx,
      );

      return instrument;
    });

    // Bars, so the symbol is chartable and markable immediately. A failure
    // here leaves the instrument in place: it exists and is simply not yet
    // backfilled, which the count reports rather than hides.
    try {
      await this.sync.sync({ symbols: [created.symbol], days: options.days ?? 365, pacingMs: 0 });
    } catch {
      /* reported through candleCount, not swallowed into a lie about success */
    }

    const candleCount = await this.db.marketDataCandle.count({
      where: { symbol: created.symbol },
    });

    return {
      symbol: created.symbol,
      name: created.name,
      assetClass: created.assetClass,
      exchange: created.exchange,
      sector: created.sector,
      isTradable: created.isTradable,
      candleCount,
    };
  }
}
