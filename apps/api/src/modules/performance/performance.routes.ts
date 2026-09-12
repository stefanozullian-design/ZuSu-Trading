import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';

/**
 * Performance and the trade journal (§42, §43, §69).
 *
 * Both return measures are always reported together. Sending only the
 * time-weighted figure would flatter a badly-timed account and only the
 * money-weighted one would flatter a well-timed strategy, and choosing which
 * to show is not this API's decision to make.
 */

const snapshotSchema = z.object({
  asOf: z.string().datetime(),
  cashBalance: z.string(),
  positionsValue: z.string(),
  equity: z.string(),
  netCashFlow: z.string(),
  realizedPnl: z.string(),
  unrealizedPnl: z.string(),
  feesTotal: z.string(),
  openPositions: z.number().int(),
});

const journalSchema = z.object({
  id: z.string().uuid(),
  portfolioId: z.string().uuid(),
  positionId: z.string().uuid().nullable(),
  signalId: z.string().uuid().nullable(),
  symbol: z.string().nullable(),
  entryThesis: z.string().nullable(),
  technicalContext: z.record(z.unknown()).nullable(),
  aiReasoning: z.string().nullable(),
  outcome: z.string().nullable(),
  lessons: z.string().nullable(),
  userNotes: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export async function registerPerformanceRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: app.requirePermission(Permission.PERFORMANCE_READ) };
  const write = { preHandler: app.requirePermission(Permission.PORTFOLIO_WRITE) };

  typed.get(
    '/report',
    {
      ...read,
      schema: {
        tags: ['performance'],
        summary: 'Time- and money-weighted returns over a window',
        description:
          'External cash movements are removed from both measures: a deposit ' +
          'is not a profit. The response carries the conventions it used.',
        querystring: z.object({
          portfolioId: z.string().uuid(),
          from: z.string().datetime(),
          to: z.string().datetime(),
        }),
        response: {
          200: z.object({
            portfolioId: z.string().uuid(),
            from: z.string().datetime(),
            to: z.string().datetime(),
            openingEquity: z.string(),
            closingEquity: z.string(),
            netDeposits: z.string(),
            investmentGain: z.string(),
            timeWeightedReturnPct: z.string().nullable(),
            moneyWeightedReturnPct: z.string().nullable(),
            realizedPnl: z.string(),
            unrealizedPnl: z.string(),
            feesPaid: z.string(),
            maxDrawdownPct: z.string(),
            snapshots: z.array(snapshotSchema),
            notes: z.array(z.string()),
          }),
        },
      },
    },
    async (request, reply) => {
      const report = await container.performance.report(
        principalOf(request),
        request.query.portfolioId,
        { from: new Date(request.query.from), to: new Date(request.query.to) },
      );
      return reply.send({
        ...report,
        from: report.from.toISOString(),
        to: report.to.toISOString(),
        snapshots: report.snapshots.map((snapshot) => ({
          ...snapshot,
          asOf: snapshot.asOf.toISOString(),
        })),
      });
    },
  );

  typed.post(
    '/snapshots',
    {
      ...write,
      schema: {
        tags: ['performance'],
        summary: 'Write the snapshot for an instant',
        description:
          'Idempotent per instant, so re-running a day recomputes it rather ' +
          'than producing two versions of the same close. The scheduler writes one a ' +
          'day; this endpoint writes one on demand.',
        body: z.object({
          portfolioId: z.string().uuid(),
          asOf: z.string().datetime().optional(),
        }),
        response: { 201: snapshotSchema },
      },
    },
    async (request, reply) => {
      await container.access.assertPortfolioAccess(principalOf(request), request.body.portfolioId, {
        permission: Permission.PORTFOLIO_WRITE,
      });
      const snapshot = await container.performance.writeSnapshot(
        request.body.portfolioId,
        request.body.asOf ? new Date(request.body.asOf) : new Date(),
      );
      return reply.code(201).send({ ...snapshot, asOf: snapshot.asOf.toISOString() });
    },
  );

  typed.post(
    '/cash-flows',
    {
      ...write,
      schema: {
        tags: ['performance'],
        summary: 'Record a deposit or a withdrawal',
        description:
          'Recorded as its own row and removed from both return measures. An ' +
          'account that grew because somebody wired money in has returned ' +
          'nothing, and this is what keeps that visible.',
        body: z.object({
          portfolioId: z.string().uuid(),
          type: z.enum(['DEPOSIT', 'WITHDRAWAL']),
          amount: z.string(),
          occurredAt: z.string().datetime().optional(),
          note: z.string().max(300).optional(),
        }),
        response: {
          201: z.object({ id: z.string().uuid(), amount: z.string(), type: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const flow = await container.performance.recordCashFlow(principalOf(request), {
        portfolioId: body.portfolioId,
        type: body.type,
        amount: body.amount,
        ...(body.occurredAt !== undefined && { occurredAt: new Date(body.occurredAt) }),
        ...(body.note !== undefined && { note: body.note }),
      });
      return reply.code(201).send(flow);
    },
  );

  typed.get(
    '/journal',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_READ),
      schema: {
        tags: ['performance'],
        summary: 'Journal entries for a portfolio',
        querystring: z.object({
          portfolioId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.object({ entries: z.array(journalSchema) }) },
      },
    },
    async (request, reply) => {
      const entries = await container.journal.list(
        principalOf(request),
        request.query.portfolioId,
        request.query.limit,
      );
      return reply.send({ entries: entries.map(serialiseEntry) });
    },
  );

  typed.post(
    '/journal/:id/notes',
    {
      ...write,
      schema: {
        tags: ['performance'],
        summary: 'Append a note to a journal entry',
        description:
          'Appends. The thesis captured at entry is never overwritten — a ' +
          'journal edited after the outcome is known stops being evidence.',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ note: z.string().min(2).max(2000) }),
        response: { 200: journalSchema },
      },
    },
    async (request, reply) => {
      const entry = await container.journal.appendNote(principalOf(request), request.params.id, {
        note: request.body.note,
      });
      return reply.send(serialiseEntry(entry));
    },
  );

  typed.post(
    '/journal/:id/outcome',
    {
      ...write,
      schema: {
        tags: ['performance'],
        summary: 'Record how a closed trade turned out',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          outcome: z.string().min(2).max(500),
          lessons: z.string().max(2000).optional(),
        }),
        response: { 200: journalSchema },
      },
    },
    async (request, reply) => {
      const entry = await container.journal.recordOutcome(
        principalOf(request),
        request.params.id,
        request.body,
      );
      return reply.send(serialiseEntry(entry));
    },
  );
}

type Entry = Awaited<ReturnType<AppContainer['journal']['list']>>[number];

function serialiseEntry(entry: Entry) {
  return {
    ...entry,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}
