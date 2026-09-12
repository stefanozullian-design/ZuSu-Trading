import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../lib/errors.js';

/**
 * Watchlists (§9).
 *
 * A watchlist is a named set of instruments. Two kinds exist, distinguished by
 * `portfolioId`: a bound watchlist belongs to one portfolio and inherits its
 * access rules, an unbound one is shared reference data. This service handles
 * the unbound and bound cases identically; the route layer is where portfolio
 * access is asserted, because that is where the caller's principal lives.
 *
 * Symbols are stored as relations to `instruments`, never as a text array — so
 * a watchlist cannot contain a symbol the platform has no record of, and
 * deleting an instrument cannot leave a dangling entry.
 *
 * Symbols come back oldest-added first, with ties broken alphabetically. There
 * is deliberately no user-defined ordering: that would need a position column
 * and a reorder endpoint, and nothing asks for it yet.
 */

export interface WatchlistSummary {
  id: string;
  name: string;
  description: string | null;
  portfolioId: string | null;
  isSystem: boolean;
  symbols: string[];
  updatedAt: Date;
}

export class WatchlistService {
  constructor(private readonly db: PrismaClient) {}

  async list(): Promise<WatchlistSummary[]> {
    const rows = await this.db.watchlist.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: {
        items: {
          // Oldest first, ties broken alphabetically. Symbols added in one
          // bulk create share a timestamp, so insertion order is not
          // recoverable; alphabetical makes the result deterministic instead
          // of dependent on how the database happened to return the rows.
          orderBy: [{ addedAt: 'asc' }, { instrument: { symbol: 'asc' } }],
          include: { instrument: { select: { symbol: true } } },
        },
      },
    });
    return rows.map(toSummary);
  }

  async get(id: string): Promise<WatchlistSummary> {
    const row = await this.db.watchlist.findUnique({
      where: { id },
      include: {
        items: {
          // Oldest first, ties broken alphabetically. Symbols added in one
          // bulk create share a timestamp, so insertion order is not
          // recoverable; alphabetical makes the result deterministic instead
          // of dependent on how the database happened to return the rows.
          orderBy: [{ addedAt: 'asc' }, { instrument: { symbol: 'asc' } }],
          include: { instrument: { select: { symbol: true } } },
        },
      },
    });
    if (!row) throw new AppError('NOT_FOUND', 'Watchlist not found');
    return toSummary(row);
  }

  async create(input: {
    name: string;
    description?: string | null;
    portfolioId?: string | null;
    symbols?: string[];
  }): Promise<WatchlistSummary> {
    const name = input.name.trim();
    if (!name) throw new AppError('VALIDATION_FAILED', 'A watchlist needs a name');

    const instrumentIds = await this.resolveSymbols(input.symbols ?? []);

    const created = await this.db.watchlist.create({
      data: {
        name,
        description: input.description ?? null,
        portfolioId: input.portfolioId ?? null,
        items: { create: instrumentIds.map((instrumentId) => ({ instrumentId })) },
      },
      include: {
        items: {
          // Oldest first, ties broken alphabetically. Symbols added in one
          // bulk create share a timestamp, so insertion order is not
          // recoverable; alphabetical makes the result deterministic instead
          // of dependent on how the database happened to return the rows.
          orderBy: [{ addedAt: 'asc' }, { instrument: { symbol: 'asc' } }],
          include: { instrument: { select: { symbol: true } } },
        },
      },
    });
    return toSummary(created);
  }

  async rename(
    id: string,
    input: { name?: string; description?: string | null },
  ): Promise<WatchlistSummary> {
    const existing = await this.db.watchlist.findUnique({ where: { id } });
    if (!existing) throw new AppError('NOT_FOUND', 'Watchlist not found');
    if (existing.isSystem) {
      // A system watchlist is seeded reference data; renaming it would make the
      // seed and the database disagree on every subsequent run.
      throw new AppError('FORBIDDEN', 'A system watchlist cannot be renamed');
    }

    await this.db.watchlist.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.description !== undefined && { description: input.description }),
      },
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.db.watchlist.findUnique({ where: { id } });
    if (!existing) throw new AppError('NOT_FOUND', 'Watchlist not found');
    if (existing.isSystem) {
      throw new AppError('FORBIDDEN', 'A system watchlist cannot be deleted');
    }
    await this.db.watchlist.delete({ where: { id } });
  }

  /** Adds a symbol. Adding one that is already present is a no-op, not an error. */
  async addSymbol(id: string, symbol: string): Promise<WatchlistSummary> {
    const normalised = symbol.trim().toUpperCase();
    const [watchlist, instrument] = await Promise.all([
      this.db.watchlist.findUnique({ where: { id }, select: { id: true } }),
      this.db.instrument.findUnique({ where: { symbol: normalised }, select: { id: true } }),
    ]);
    if (!watchlist) throw new AppError('NOT_FOUND', 'Watchlist not found');
    if (!instrument) {
      throw new AppError(
        'NOT_FOUND',
        `${normalised} is not a known instrument. Only instruments the platform has a record of can be watched.`,
      );
    }

    await this.db.watchlistItem.upsert({
      where: { watchlistId_instrumentId: { watchlistId: id, instrumentId: instrument.id } },
      create: { watchlistId: id, instrumentId: instrument.id },
      update: {},
    });
    return this.get(id);
  }

  /** Removes a symbol. Removing one that is absent is a no-op. */
  async removeSymbol(id: string, symbol: string): Promise<WatchlistSummary> {
    const normalised = symbol.trim().toUpperCase();
    const instrument = await this.db.instrument.findUnique({
      where: { symbol: normalised },
      select: { id: true },
    });
    if (instrument) {
      await this.db.watchlistItem.deleteMany({
        where: { watchlistId: id, instrumentId: instrument.id },
      });
    }
    return this.get(id);
  }

  /** The symbols a scan should cover: one watchlist's, or every instrument. */
  async symbolsFor(watchlistId: string | null): Promise<string[]> {
    if (watchlistId) {
      const watchlist = await this.get(watchlistId);
      return watchlist.symbols;
    }
    const instruments = await this.db.instrument.findMany({
      where: { isTradable: true },
      orderBy: { symbol: 'asc' },
      select: { symbol: true },
    });
    return instruments.map((instrument) => instrument.symbol);
  }

  private async resolveSymbols(symbols: string[]): Promise<string[]> {
    const normalised = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean);
    if (normalised.length === 0) return [];

    const found = await this.db.instrument.findMany({
      where: { symbol: { in: normalised } },
      select: { id: true, symbol: true },
    });
    const missing = normalised.filter((s) => !found.some((f) => f.symbol === s));
    if (missing.length > 0) {
      // Fail the whole create rather than silently dropping symbols — a
      // watchlist that quietly lost half its entries is worse than an error.
      throw new AppError(
        'NOT_FOUND',
        `Unknown instrument(s): ${missing.join(', ')}. None were added.`,
      );
    }
    return found.map((f) => f.id);
  }
}

interface WatchlistRow {
  id: string;
  name: string;
  description: string | null;
  portfolioId: string | null;
  isSystem: boolean;
  updatedAt: Date;
  items: { instrument: { symbol: string } }[];
}

function toSummary(row: WatchlistRow): WatchlistSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    portfolioId: row.portfolioId,
    isSystem: row.isSystem,
    symbols: row.items.map((item) => item.instrument.symbol),
    updatedAt: row.updatedAt,
  };
}
