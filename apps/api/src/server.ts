import { buildApp } from './app.js';
import { config } from './config/env.js';
import { disconnectPrisma } from './lib/prisma.js';
import { disconnectRedis } from './lib/redis.js';

async function main(): Promise<void> {
  const cfg = config();
  const { app } = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await disconnectPrisma();
      await disconnectRedis();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'unhandled rejection');
  });

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  // `environment` is already a base field on every log line; naming it again
  // here would emit a duplicate key.
  app.log.info(
    { liveTradingAllowed: cfg.ALLOW_LIVE_TRADING, port: cfg.PORT },
    'ZuSu Trading API listening',
  );
}

main().catch((err) => {
  // The config loader throws here when a secret is missing; the message names
  // the variable but never its value.
  console.error('Failed to start API:', err instanceof Error ? err.message : err);
  process.exit(1);
});
