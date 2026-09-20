import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  Permission,
  compositionSchema,
  createPortfolioSchema,
  portfolioSummarySchema,
  positionSchema,
  recordTradeSchema,
  recordedTradeSchema,
  switchEnvironmentSchema,
  tradeHistoryEntrySchema,
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

  typed.delete(
    '/:id',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_WRITE),
      schema: {
        tags: ['portfolios'],
        summary: 'Delete a portfolio and everything that belonged to it',
        description:
          'The name must be typed to confirm: a confirmation that can be clicked through ' +
          'without reading is not one. A LIVE portfolio is never deletable. The audit log is ' +
          'untouched — every entry the portfolio produced stays, including one written just ' +
          'before it went that names what was deleted and by whom.',
        params: idParams,
        querystring: z.object({ confirmName: z.string().min(1).max(120) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await container.portfolios.remove(
        principalOf(request),
        request.params.id,
        request.query.confirmName,
      );
      return reply.status(204).send(null);
    },
  );

  typed.post(
    '/:id/environment',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_WRITE),
      schema: {
        tags: ['portfolios'],
        summary: 'Move a portfolio between practice and paper',
        description:
          'LIVE is absent from the accepted values, so a request to become live is rejected by ' +
          'the schema before any code decides. The switch draws a line: holdings come across as ' +
          'declarations and performance is measured from the switch, because everything before ' +
          'it happened under other prices.',
        params: idParams,
        body: switchEnvironmentSchema,
        response: { 200: portfolioSummarySchema },
      },
    },
    async (request, reply) =>
      reply.send(
        await container.portfolios.switchEnvironment(
          principalOf(request),
          request.params.id,
          request.body.environment,
        ),
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
    '/:id/composition',
    {
      preHandler: app.requirePermission(Permission.POSITION_READ),
      schema: {
        tags: ['portfolios'],
        summary: 'What the portfolio is made of, and what is worth knowing about it',
        description:
          'Holdings with their weights, the sector breakdown, concentration, and findings ' +
          'measured against the limits this portfolio’s objective implies. One call rather ' +
          'than several, because every percentage divides by the same equity: assembling them ' +
          'from separate requests would let a sector weight and a holding weight be computed ' +
          'against different valuations. If any holding cannot be priced, every percentage is ' +
          'null and `unpriced` names the symbols — a weight computed against an incomplete ' +
          'valuation overstates every other holding.',
        params: idParams,
        response: { 200: compositionSchema },
      },
    },
    async (request, reply) =>
      reply.send(await container.composition.forPortfolio(principalOf(request), request.params.id)),
  );

  typed.post(
    '/:id/trades',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_WRITE),
      schema: {
        tags: ['portfolios'],
        summary: 'Record a trade or cash movement that happened elsewhere',
        description:
          'These portfolios are held at a real brokerage. This records what was done there: a ' +
          'buy, a sell, a dividend, a deposit or a withdrawal. Buys and sells go through the ' +
          'same first-in-first-out tax-lot engine a routed fill uses, so a realised gain is ' +
          'computed one way only. No order and no execution is created, because nothing here ' +
          'routed it — the tax lot carries no fill id rather than pointing at an invented one. ' +
          'Recorded cash is allowed to go negative, and says so: the real cash is at the ' +
          'broker, and a deposit entered late is ordinary rather than a fault. Selling more ' +
          'than the book shows is refused rather than turned into a short position.',
        params: idParams,
        body: recordTradeSchema,
        response: { 201: recordedTradeSchema },
      },
    },
    async (request, reply) => {
      const { type, occurredAt, symbol, quantity, price, amount, fees, note } = request.body;
      const recorded = await container.tradeRecords.record(principalOf(request), {
        portfolioId: request.params.id,
        type,
        occurredAt: new Date(occurredAt),
        ...(symbol !== undefined && { symbol }),
        ...(quantity !== undefined && { quantity }),
        ...(price !== undefined && { price }),
        ...(amount !== undefined && { amount }),
        ...(fees !== undefined && { fees }),
        ...(note !== undefined && { note }),
      });
      return reply.status(201).send(recorded);
    },
  );

  typed.get(
    '/:id/trades',
    {
      preHandler: app.requirePermission(Permission.POSITION_READ),
      schema: {
        tags: ['portfolios'],
        summary: 'What has been recorded for a portfolio, newest first',
        description:
          'Read from the ledger of entries rather than reconstructed from positions and lots. ' +
          'A reconstruction could only show the entries a later trade has not already absorbed.',
        params: idParams,
        querystring: z.object({
          symbol: z.string().trim().min(1).max(12).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: { 200: z.array(tradeHistoryEntrySchema) },
      },
    },
    async (request, reply) =>
      reply.send(
        await container.tradeRecords.history(principalOf(request), request.params.id, {
          ...(request.query.symbol !== undefined && { symbol: request.query.symbol }),
          limit: request.query.limit,
        }),
      ),
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
