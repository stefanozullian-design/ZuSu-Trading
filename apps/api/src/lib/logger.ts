import { pino, type Logger, type LoggerOptions } from 'pino';
import { config } from '../config/env.js';

/**
 * Structured logging. The redaction list is the last line of defence — code is
 * still expected never to put a secret into a log record in the first place.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.totp',
  '*.mfaSecret',
  '*.mfaToken',
  '*.credentials',
  '*.credentialsEnc',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.secret',
  'password',
  'passwordHash',
  'mfaSecret',
  'credentials',
  'credentialsEnc',
  'secret',
  'apiKey',
];

export function loggerOptions(): LoggerOptions {
  const cfg = config();
  return {
    level: cfg.isTest ? 'silent' : cfg.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'zusu-api', environment: cfg.DEFAULT_ENVIRONMENT },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      cfg.isProduction || cfg.isTest
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
  };
}

export function createLogger(): Logger {
  return pino(loggerOptions());
}

export type { Logger };
