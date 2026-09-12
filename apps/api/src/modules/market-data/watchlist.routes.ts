import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';
import { scanConditionsSchema } from './scan.service.js';
import { TIMEFRAMES } from './types.js';

/**
 * Watchlists and saved scans (§9).
 *
 * Reading needs `market_data:read`, which every role has. Writing needs
 * `watchlist:write`, which stops at MANAGER — a VIEWER may look at market data
 * but does not get to reconfigure the platform.
 *
 * A scan run is a GET-shaped question posed with POST, because a filter is too
 * large and too nested to put in a query string. It creates nothing and
 * changes nothing except a saved scan's `lastRunAt`.
 */

const idParams = z.object({ id: z.string().uuid() });
const timeframe = z.enum(TIMEFRAMES);

const watchlistSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  portfolioId: z.string().uuid().nullable(),
  isSystem: z.boolean(),
  symbols: z.array(z.string()),
  updatedAt: z.string().datetime(),
});

const scanSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  timeframe: z.string(),
  conditions: z.array(z.record(z.unknown())),
  summary: z.array(z.string()),
  watchlistId: z.string().uuid().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

const runResultSchema = z.object({
  timeframe: z.string(),
  ranAt: z.string().datetime(),
  summary: z.array(z.string()),
  universe: z.array(z.string()),
  evaluated: z.number().int(),
  matches: z.array(
    z.object({
      symbol: z.string(),
      asOf: z.string().datetime(),
      values: z.record(z.string()),
    }),
  ),
  notEvaluable: z.array(
    z.object({
      symbol: z.string(),
      reason: z.string(),
      missingField: z.string().nullable(),
    }),
  ),
});

export async function registerWatchlistRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: app.requirePermission(Permission.MARKET_DATA_READ) };
  const write = { preHandler: app.requirePermission(Permission.WATCHLIST_WRITE) };

  // ---- Watchlists -------------------------------------------------------

  typed.get(
    '/watchlists',
    {
      ...read,
      schema: {
        tags: ['watchlists'],
        summary: 'Every watchlist with its symbols',
        response: { 200: z.object({ watchlists: z.array(watchlistSchema) }) },
      },
    },
    async (_request, reply) => {
      const watchlists = await container.watchlists.list();
      return reply.send({ watchlists: watchlists.map(serialiseWatchlist) });
    },
  );

  typed.post(
    '/watchlists',
    {
      ...write,
      schema: {
        tags: ['watchlists'],
        summary: 'Create a watchlist',
        description:
          'An unknown symbol fails the whole request rather than being dropped: ' +
          'a watchlist that quietly lost half its entries is worse than an error.',
        body: z.object({
          name: z.string().min(1).max(80),
          description: z.string().max(400).nullable().optional(),
          symbols: z.array(z.string().min(1).max(20)).max(200).optional(),
        }),
        response: { 201: watchlistSchema },
      },
    },
    async (request, reply) => {
      const created = await container.watchlists.create(request.body);
      return reply.code(201).send(serialiseWatchlist(created));
    },
  );

  typed.patch(
    '/watchlists/:id',
    {
      ...write,
      schema: {
        tags: ['watchlists'],
        summary: 'Rename a watchlist or change its description',
        params: idParams,
        body: z.object({
          name: z.string().min(1).max(80).optional(),
          description: z.string().max(400).nullable().optional(),
        }),
        response: { 200: watchlistSchema },
      },
    },
    async (request, reply) => {
      const updated = await container.watchlists.rename(request.params.id, request.body);
      return reply.send(serialiseWatchlist(updated));
    },
  );

  typed.delete(
    '/watchlists/:id',
    {
      ...write,
      schema: {
        tags: ['watchlists'],
        summary: 'Delete a watchlist',
        params: idParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await container.watchlists.remove(request.params.id);
      return reply.code(204).send(null);
    },
  );

  typed.post(
    '/watchlists/:id/symbols',
    {
      ...write,
      schema: {
        tags: ['watchlists'],
        summary: 'Add a symbol to a watchlist',
        params: idParams,
        body: z.object({ symbol: z.string().min(1).max(20) }),
        response: { 200: watchlistSchema },
      },
    },
    async (request, reply) => {
      const updated = await container.watchlists.addSymbol(request.params.id, request.body.symbol);
      return reply.send(serialiseWatchlist(updated));
    },
  );

  typed.delete(
    '/watchlists/:id/symbols/:symbol',
    {
      ...write,
      schema: {
        tags: ['watchlists'],
        summary: 'Remove a symbol from a watchlist',
        params: idParams.extend({ symbol: z.string().min(1).max(20) }),
        response: { 200: watchlistSchema },
      },
    },
    async (request, reply) => {
      const updated = await container.watchlists.removeSymbol(
        request.params.id,
        request.params.symbol,
      );
      return reply.send(serialiseWatchlist(updated));
    },
  );

  // ---- Scans ------------------------------------------------------------

  typed.get(
    '/scans',
    {
      ...read,
      schema: {
        tags: ['scans'],
        summary: 'Saved scans',
        response: { 200: z.object({ scans: z.array(scanSchema) }) },
      },
    },
    async (_request, reply) => {
      const scans = await container.scans.list();
      return reply.send({ scans: scans.map(serialiseScan) });
    },
  );

  typed.post(
    '/scans',
    {
      ...write,
      schema: {
        tags: ['scans'],
        summary: 'Save a scan',
        body: z.object({
          name: z.string().min(1).max(80),
          description: z.string().max(400).nullable().optional(),
          timeframe,
          conditions: scanConditionsSchema,
          watchlistId: z.string().uuid().nullable().optional(),
        }),
        response: { 201: scanSchema },
      },
    },
    async (request, reply) => {
      const created = await container.scans.create({
        ...request.body,
        createdBy: principalOf(request).id,
      });
      return reply.code(201).send(serialiseScan(created));
    },
  );

  typed.patch(
    '/scans/:id',
    {
      ...write,
      schema: {
        tags: ['scans'],
        summary: 'Edit a saved scan',
        params: idParams,
        body: z.object({
          name: z.string().min(1).max(80).optional(),
          description: z.string().max(400).nullable().optional(),
          timeframe: timeframe.optional(),
          conditions: scanConditionsSchema.optional(),
          watchlistId: z.string().uuid().nullable().optional(),
        }),
        response: { 200: scanSchema },
      },
    },
    async (request, reply) => {
      const updated = await container.scans.update(request.params.id, request.body);
      return reply.send(serialiseScan(updated));
    },
  );

  typed.delete(
    '/scans/:id',
    {
      ...write,
      schema: {
        tags: ['scans'],
        summary: 'Delete a saved scan',
        params: idParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await container.scans.remove(request.params.id);
      return reply.code(204).send(null);
    },
  );

  typed.post(
    '/scans/run',
    {
      ...read,
      schema: {
        tags: ['scans'],
        summary: 'Run a filter without saving it',
        description:
          'Symbols whose indicators are still in warm-up are returned under ' +
          '`notEvaluable`, never silently excluded — so "no matches" can be ' +
          'told apart from "not enough data".',
        body: z.object({
          timeframe,
          conditions: scanConditionsSchema,
          watchlistId: z.string().uuid().nullable().optional(),
          barLimit: z.number().int().min(2).max(2000).optional(),
        }),
        response: { 200: runResultSchema },
      },
    },
    async (request, reply) => {
      const result = await container.scans.run(request.body);
      return reply.send(serialiseRun(result));
    },
  );

  typed.post(
    '/scans/:id/run',
    {
      ...read,
      schema: {
        tags: ['scans'],
        summary: 'Run a saved scan',
        params: idParams,
        body: z.object({ barLimit: z.number().int().min(2).max(2000).optional() }).optional(),
        response: { 200: runResultSchema },
      },
    },
    async (request, reply) => {
      const result = await container.scans.runSaved(request.params.id, request.body ?? {});
      return reply.send(serialiseRun(result));
    },
  );
}

function serialiseWatchlist(watchlist: {
  id: string;
  name: string;
  description: string | null;
  portfolioId: string | null;
  isSystem: boolean;
  symbols: string[];
  updatedAt: Date;
}) {
  return { ...watchlist, updatedAt: watchlist.updatedAt.toISOString() };
}

function serialiseScan(scan: {
  id: string;
  name: string;
  description: string | null;
  timeframe: string;
  conditions: unknown[];
  summary: string[];
  watchlistId: string | null;
  lastRunAt: Date | null;
  updatedAt: Date;
}) {
  return {
    ...scan,
    conditions: scan.conditions as Record<string, unknown>[],
    lastRunAt: scan.lastRunAt ? scan.lastRunAt.toISOString() : null,
    updatedAt: scan.updatedAt.toISOString(),
  };
}

function serialiseRun(result: {
  timeframe: string;
  ranAt: Date;
  summary: string[];
  universe: string[];
  evaluated: number;
  matches: { symbol: string; asOf: Date; values: Record<string, string> }[];
  notEvaluable: { symbol: string; reason: string; missingField: string | null }[];
}) {
  return {
    timeframe: result.timeframe,
    ranAt: result.ranAt.toISOString(),
    summary: result.summary,
    universe: result.universe,
    evaluated: result.evaluated,
    matches: result.matches.map((match) => ({
      symbol: match.symbol,
      asOf: match.asOf.toISOString(),
      values: match.values,
    })),
    notEvaluable: result.notEvaluable,
  };
}
