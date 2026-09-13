import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission, createClientSchema, updateClientSchema } from '@zusu/shared';
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
        description:
          'Retired owners are left out unless asked for. They are never deleted — an owner is ' +
          'referenced by append-only audit rows from the moment they exist.',
        querystring: z.object({
          includeInactive: z
            .enum(['true', 'false'])
            .default('false')
            .transform((v) => v === 'true'),
        }),
        response: { 200: z.array(clientSchema) },
      },
    },
    async (request, reply) =>
      reply.send(
        await container.clients.list(principalOf(request), {
          includeInactive: request.query.includeInactive,
        }),
      ),
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

  typed.patch(
    '/:id',
    {
      preHandler: app.requirePermission(Permission.CLIENT_WRITE),
      schema: {
        tags: ['clients'],
        summary: 'Rename an owner, change their contact details, or retire them',
        description:
          'There is no delete. Retiring takes an owner out of every picker and keeps their ' +
          'history, which is what "delete" is usually meant to achieve.',
        params: z.object({ id: z.string().uuid() }),
        body: updateClientSchema,
        response: { 200: clientSchema },
      },
    },
    async (request, reply) =>
      reply.send(
        await container.clients.update(principalOf(request), request.params.id, request.body),
      ),
  );
}
