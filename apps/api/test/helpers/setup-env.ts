/**
 * Test configuration. Deterministic secrets, an isolated database and a fixed
 * demo seed — nothing here is ever used outside `NODE_ENV=test`.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://zusu:zusu@127.0.0.1:5432/zusu_trading_test?schema=public';
delete process.env.REDIS_URL;
process.env.JWT_SECRET = 'test-jwt-secret-that-is-definitely-long-enough-000';
process.env.COOKIE_SECRET = 'test-cookie-secret-that-is-long-enough-0000000000';
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.COOKIE_SECURE = 'false';
process.env.ALLOW_LIVE_TRADING = 'false';
process.env.DEFAULT_ENVIRONMENT = 'DEMO';
process.env.DEMO_SEED = '20260101';
process.env.RATE_LIMIT_MAX = '10000';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
