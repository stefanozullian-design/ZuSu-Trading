import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  Permission,
  createPortfolioSchema,
  portfolioSummarySchema,
  positionSchema,
  updatePortfolioSchema,
} from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';

const idParams = z.object({ id: z.string().uuid() });

const importPositionSchema = z.object({
  symbol: z.string().trim().min(1).max(12),
  quantity: z.string().refine((v) => Number(v) > 0, { message: 'must be a positive number' }),
  averageEntryPrice: z
    .string()
    .refine((v) => Number(v) > 0, { message: 'must be a positive number' }),
  acquiredAt: z.string().datetime(),
  note: z.string().max(500).optional(),
});

const importedPositionSchema = z.object({
  id: z.string(),
  portfolioId: z.string(),
  symbol: z.string(),
  quantity: z.string(),
  averageEntryPrice: z.string(),
  costBasis: z.string(),
  acquiredAt: z.string(),
  origin: z.literal('IMPORTED'),
  cashFlowId: z.string(),
  detail: z.string(),
});

export async function registerPortfolioRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_READ),
      schema: {
        tags: ['portfolios'],
        summary: 'Portfolios the caller may see',
        description:
          'Closed portfolios are left out unless asked for. They are never deleted — a ' +
          'portfolio is referenced by append-only audit rows from the moment it exists.',
        querystring: z.object({
          includeClosed: z
            .enum(['true', 'false'])
            .default('false')
            .transform((v) => v === 'true'),
          /**
           * The owner to filter by. The literal string `none` asks for the
           * portfolios with nobody assigned — a real question, and the only
           * way to find the ones somebody forgot to assign. Omitted means no
           * filter at all, which is not the same thing.
           */
          ownerId: z.union([z.literal('none'), z.string().uuid()]).optional(),
        }),
        response: { 200: z.array(portfolioSummarySchema) },
      },
    },
    async (request, reply) =>
      reply.send(
        await container.portfolios.list(principalOf(request), {
          includeClosed: request.query.includeClosed,
          ...(request.query.ownerId === undefined
            ? {}
            : { clientId: request.query.ownerId === 'none' ? null : request.query.ownerId }),
        }),
      ),
  );

  typed.post(
    '/',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_WRITE),
      schema: {
        tags: ['portfolios'],
        summary: 'Create a portfolio, with starting risk limits set by its objective',
        body: createPortfolioSchema,
        response: { 201: portfolioSummarySchema },
      },
    },
    async (request, reply) => {
      const summary = await container.portfolios.create(principalOf(request), request.body);
      return reply.status(201).send(summary);
    },
  );

  typed.get(
    '/:id',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_READ),
      schema: {
        tags: ['portfolios'],
        summary: 'A single portfolio summary',
        params: idParams,
        response: { 200: portfolioSummarySchema },
      },
    },
    async (request, reply) =>
      reply.send(await container.portfolios.get(principalOf(request), request.params.id)),
  );

  typed.patch(
    '/:id',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_WRITE),
      schema: {
        tags: ['portfolios'],
        summary:
          'Rename a portfolio, reassign its owner or objective, change its execution mode, or deactivate it',
        params: idParams,
        body: updatePortfolioSchema,
        response: { 200: portfolioSummarySchema },
      },
    },
    async (request, reply) =>
      reply.send(
        await container.portfolios.update(principalOf(request), request.params.id, request.body),
      ),
  );

  typed.get(
    '/:id/positions',
    {
      preHandler: app.requirePermission(Permission.POSITION_READ),
      schema: {
        tags: ['portfolios'],
        summary: 'Open positions recorded for a portfolio',
        description:
          'Mark prices come from the environment’s market-data source. When none is ' +
          'available the mark and derived values are null rather than an entry-price stand-in.',
        params: idParams,
        response: { 200: z.array(positionSchema) },
      },
    },
    async (request, reply) =>
      reply.send(await container.portfolios.positions(principalOf(request), request.params.id)),
  );

  typed.post(
    '/:id/positions/import',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_WRITE),
      schema: {
        tags: ['portfolios'],
        summary: 'Record shares already held before this platform was watching',
        description:
          'Creates a position marked IMPORTED, with a tax lot so it can later be sold, and a ' +
          'TRANSFER_IN cash flow for its cost so the arrival is never read as a gain. It moves ' +
          'no cash, creates no order, and credits no strategy.',
        params: idParams,
        body: importPositionSchema,
        response: { 201: importedPositionSchema },
      },
    },
    async (request, reply) => {
      const imported = await container.positionImport.importPosition(principalOf(request), {
        portfolioId: request.params.id,
        symbol: request.body.symbol,
        quantity: request.body.quantity,
        averageEntryPrice: request.body.averageEntryPrice,
        acquiredAt: new Date(request.body.acquiredAt),
        ...(request.body.note !== undefined && { note: request.body.note }),
      });
      return reply.status(201).send(imported);
    },
  );

  typed.get(
    '/:id/positions/imported',
    {
      preHandler: app.requirePermission(Permission.POSITION_READ),
      schema: {
        tags: ['portfolios'],
        summary: 'Positions declared as already held, newest acquisition first',
        params: idParams,
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              symbol: z.string(),
              status: z.string(),
              quantity: z.string(),
              averageEntryPrice: z.string(),
              acquiredAt: z.string(),
            }),
          ),
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await container.positionImport.listImported(principalOf(request), request.params.id),
      ),
  );
}
