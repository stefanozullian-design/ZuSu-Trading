import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission, createClientSchema } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';

const clientSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  externalRef: z.string().nullable(),
  contactEmail: z.string().nullable(),
  isActive: z.boolean(),
  portfolioCount: z.number().int(),
  createdAt: z.string().datetime(),
});

export async function registerClientRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/',
    {
      preHandler: app.requirePermission(Permission.CLIENT_READ),
      schema: {
        tags: ['clients'],
        summary: 'List clients',
        response: { 200: z.array(clientSchema) },
      },
    },
    async (request, reply) => reply.send(await container.clients.list(principalOf(request))),
  );

  typed.post(
    '/',
    {
      preHandler: app.requirePermission(Permission.CLIENT_WRITE),
      schema: {
        tags: ['clients'],
        summary: 'Create a client',
        body: createClientSchema,
        response: { 201: clientSchema },
      },
    },
    async (request, reply) => {
      const client = await container.clients.create(principalOf(request), request.body);
      return reply.status(201).send(client);
    },
  );
}
