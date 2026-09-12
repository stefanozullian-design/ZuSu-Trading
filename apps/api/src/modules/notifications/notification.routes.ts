import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';

/**
 * Notifications (§56).
 *
 * One channel works: a row this application shows you. Push, email and the
 * rest exist in the schema with no transport behind them, and the service
 * refuses them rather than marking something SENT that nothing sent.
 */

const notificationSchema = z.object({
  id: z.string().uuid(),
  event: z.string(),
  title: z.string(),
  body: z.string(),
  status: z.string(),
  channel: z.string(),
  portfolioId: z.string().uuid().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string().datetime(),
  sentAt: z.string().datetime().nullable(),
});

export async function registerNotificationRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/',
    {
      // Your own inbox needs no permission beyond being signed in — but it
      // does need that: authentication is per route in this API, not global.
      preHandler: app.requireAuth,
      schema: {
        tags: ['notifications'],
        summary: 'Your notifications',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
        response: { 200: z.object({ notifications: z.array(notificationSchema) }) },
      },
    },
    async (request, reply) => {
      const notifications = await container.notifications.listFor(
        principalOf(request),
        request.query.limit,
      );
      return reply.send({ notifications: notifications.map(serialise) });
    },
  );

  typed.post(
    '/:id/dismiss',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['notifications'],
        summary: 'Dismiss one of your notifications',
        description: 'An inbox, not an archive: dismissing removes it.',
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await container.notifications.dismiss(principalOf(request), request.params.id);
      return reply.code(204).send(null);
    },
  );

  typed.get(
    '/portfolio/:id',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_READ),
      schema: {
        tags: ['notifications'],
        summary: 'Everything notified about a portfolio',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ notifications: z.array(notificationSchema) }) },
      },
    },
    async (request, reply) => {
      const notifications = await container.notifications.listForPortfolio(
        principalOf(request),
        request.params.id,
      );
      return reply.send({ notifications: notifications.map(serialise) });
    },
  );
}

type Notification = Awaited<ReturnType<AppContainer['notifications']['listFor']>>[number];

function serialise(notification: Notification) {
  return {
    ...notification,
    createdAt: notification.createdAt.toISOString(),
    sentAt: notification.sentAt ? notification.sentAt.toISOString() : null,
  };
}
