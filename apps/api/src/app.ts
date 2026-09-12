import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { config } from './config/env.js';
import { buildContainer, type AppContainer } from './container.js';
import { createLogger, loggerOptions } from './lib/logger.js';
import { registerAuditRoutes } from './modules/audit/audit.routes.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { registerBacktestRoutes } from './modules/backtest/backtest.routes.js';
import { verifyAccessToken } from './modules/auth/tokens.js';
import { registerBrokerRoutes } from './modules/broker/broker.routes.js';
import { registerClientRoutes } from './modules/clients/client.routes.js';
import { registerSystemRoutes } from './modules/health/health.routes.js';
import { registerMarketDataRoutes } from './modules/market-data/market-data.routes.js';
import { registerWatchlistRoutes } from './modules/market-data/watchlist.routes.js';
import { registerPortfolioRoutes } from './modules/portfolios/portfolio.routes.js';
import { registerRiskRoutes } from './modules/risk/risk.routes.js';
import { registerStrategyRoutes } from './modules/strategies/strategy.routes.js';
import { authPlugin } from './plugins/auth.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { ACCESS_COOKIE, securityPlugin } from './plugins/security.js';

export interface BuiltApp {
  app: FastifyInstance;
  container: AppContainer;
}

export async function buildApp(options: { container?: AppContainer } = {}): Promise<BuiltApp> {
  const cfg = config();
  const logger = createLogger();
  const container = options.container ?? buildContainer({ logger });

  const app = Fastify({
    logger: loggerOptions(),
    trustProxy: true,
    // A correlation id per request ties log lines, audit rows and websocket
    // envelopes to the same trace (§57).
    genReqId: () => randomUUID(),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandlerPlugin);
  await app.register(securityPlugin);
  await app.register(authPlugin, { container });
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'ZuSu Trading API',
        version: '0.1.0',
        description:
          'Day-trading automation platform. Phase 1 covers identity, portfolios, the demo ' +
          'broker, the trading gate and the audit log. Endpoints that would place orders do ' +
          'not exist yet — they arrive with the risk engine and order manager.',
      },
      servers: [{ url: '/', description: 'this deployment' }],
      tags: [
        { name: 'auth', description: 'Sessions, MFA and the current user' },
        { name: 'clients', description: 'Client records' },
        { name: 'portfolios', description: 'Portfolios and positions' },
        { name: 'broker', description: 'Read-only broker views' },
        { name: 'risk', description: 'Trading gate, limits and the kill switch' },
        { name: 'audit', description: 'Append-only audit log' },
        { name: 'system', description: 'Health, readiness and environment' },
      ],
      components: {
        securitySchemes: {
          sessionCookie: { type: 'apiKey', in: 'cookie', name: ACCESS_COOKIE },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  if (!cfg.isProduction) {
    await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list' } });
  }

  // Each module is registered inside its own encapsulated scope so a plugin
  // added for one route group cannot leak into another.
  await app.register(async (api) => registerAuthRoutes(api, container), { prefix: '/api/auth' });
  await app.register(async (api) => registerClientRoutes(api, container), {
    prefix: '/api/clients',
  });
  await app.register(async (api) => registerPortfolioRoutes(api, container), {
    prefix: '/api/portfolios',
  });
  await app.register(async (api) => registerBrokerRoutes(api, container), {
    prefix: '/api/broker',
  });
  await app.register(async (api) => registerMarketDataRoutes(api, container), {
    prefix: '/api/market-data',
  });
  await app.register(async (api) => registerWatchlistRoutes(api, container), {
    prefix: '/api/market-data',
  });
  await app.register(async (api) => registerRiskRoutes(api, container), { prefix: '/api/risk' });
  await app.register(async (api) => registerStrategyRoutes(api, container), {
    prefix: '/api/strategies',
  });
  await app.register(async (api) => registerBacktestRoutes(api, container), {
    prefix: '/api/backtests',
  });
  await app.register(async (api) => registerAuditRoutes(api, container), { prefix: '/api/audit' });
  await app.register(async (api) => registerSystemRoutes(api, container), {
    prefix: '/api/system',
  });

  await registerWebSocket(app, container);

  container.ws.start();
  app.addHook('onClose', async () => {
    container.ws.stop();
  });

  return { app, container };
}

async function registerWebSocket(app: FastifyInstance, container: AppContainer): Promise<void> {
  app.get('/ws', { websocket: true }, async (socket, request) => {
    // The socket authenticates with the same cookie as the REST API; an
    // unauthenticated socket is closed rather than left open and silent.
    const token = request.cookies[ACCESS_COOKIE];
    if (!token) {
      socket.close(4401, 'authentication required');
      return;
    }

    try {
      const claims = await verifyAccessToken(token);
      const user = await container.db.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, role: true, clientId: true, email: true, isActive: true },
      });
      if (!user?.isActive) {
        socket.close(4401, 'account unavailable');
        return;
      }

      const portfolioIds =
        user.role === 'ADMIN' ? null : await container.access.listAccessiblePortfolioIds(user);
      container.ws.register(socket, user.id, portfolioIds);
    } catch {
      socket.close(4401, 'authentication failed');
    }
  });
}
