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
        response: { 200: z.array(portfolioSummarySchema) },
      },
    },
    async (request, reply) => reply.send(await container.portfolios.list(principalOf(request))),
  );

  typed.post(
    '/',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_WRITE),
      schema: {
        tags: ['portfolios'],
        summary: 'Create a portfolio with conservative default risk limits',
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
        summary: 'Rename a portfolio, change its execution mode or deactivate it',
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
}
