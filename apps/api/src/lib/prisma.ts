import { PrismaClient } from '@prisma/client';
import { config } from '../config/env.js';

let client: PrismaClient | null = null;

export function prisma(): PrismaClient {
  client ??= new PrismaClient({
    datasources: { db: { url: config().DATABASE_URL } },
    log: config().isTest
      ? []
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  });
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
