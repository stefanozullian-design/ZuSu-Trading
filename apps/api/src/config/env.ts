import { z } from 'zod';
import { TradingEnvironment } from '@zusu/shared';

/**
 * Configuration is validated once, at boot. A missing or malformed secret is a
 * startup failure, never a runtime surprise in the middle of a trading session.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().optional(),

  /** Signing key for short-lived access tokens. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** Signing key for cookie integrity. */
  COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET must be at least 32 characters'),
  /** 32 raw bytes, base64-encoded. Encrypts broker credentials and TOTP seeds. */
  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as base64',
    ),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(60 * 60 * 24 * 90)
    .default(60 * 60 * 24 * 14),
  MFA_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),

  /** Environment the API boots into. Portfolios outside it are read-only. */
  DEFAULT_ENVIRONMENT: z
    .enum(['DEMO', 'PAPER', 'LIVE'])
    .default('DEMO') as z.ZodType<TradingEnvironment>,

  /**
   * Master switch for real-money trading. Even with a LIVE portfolio and a real
   * broker credential, nothing reaches a live broker while this is false.
   */
  ALLOW_LIVE_TRADING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  COOKIE_DOMAIN: z.string().optional(),
  /** Set false only for local plain-HTTP development. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),

  /** Deterministic seed for the demo market simulator. */
  DEMO_SEED: z.coerce.number().int().default(20260101),

  ANTHROPIC_API_KEY: z.string().optional(),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>> & {
  readonly isProduction: boolean;
  readonly isTest: boolean;
};

/** Keys whose values must never appear in logs, errors or API responses. */
export const SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'COOKIE_SECRET',
  'CREDENTIAL_ENCRYPTION_KEY',
  'ANTHROPIC_API_KEY',
] as const;

let cached: AppConfig | null = null;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Report which variables are wrong, never what they contain.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const data = parsed.data;
  const config: AppConfig = Object.freeze({
    ...data,
    isProduction: data.NODE_ENV === 'production',
    isTest: data.NODE_ENV === 'test',
  });

  if (config.isProduction && !config.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE cannot be false in production');
  }
  return config;
}

export function config(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test helper — never called from application code. */
export function resetConfigCache(): void {
  cached = null;
}
