/**
 * Error taxonomy. Every failure surfaced to a client carries a stable machine
 * code and a human-readable message — risk rejections in particular must be
 * explainable to the person who was denied a trade (§20).
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'MFA_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'ENVIRONMENT_MISMATCH'
  | 'LIVE_TRADING_DISABLED'
  | 'TRADING_HALTED'
  | 'RISK_REJECTED'
  | 'BROKER_UNAVAILABLE'
  | 'DATA_QUALITY'
  | 'SERVICE_DEGRADED'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  ENVIRONMENT_MISMATCH: 409,
  LIVE_TRADING_DISABLED: 403,
  TRADING_HALTED: 409,
  RISK_REJECTED: 422,
  BROKER_UNAVAILABLE: 503,
  DATA_QUALITY: 503,
  SERVICE_DEGRADED: 503,
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  /** Safe to show to an end user? Internal errors never are. */
  readonly exposeMessage: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; cause?: unknown; exposeMessage?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = options.details;
    this.exposeMessage = options.exposeMessage ?? code !== 'INTERNAL';
  }
}

export const badRequest = (m: string, details?: unknown) =>
  new AppError('BAD_REQUEST', m, { details });
export const unauthenticated = (m = 'Authentication required') =>
  new AppError('UNAUTHENTICATED', m);
export const forbidden = (m = 'You do not have access to this resource') =>
  new AppError('FORBIDDEN', m);
export const notFound = (m = 'Not found') => new AppError('NOT_FOUND', m);
export const conflict = (m: string, details?: unknown) => new AppError('CONFLICT', m, { details });
export const notImplemented = (m: string) => new AppError('NOT_IMPLEMENTED', m);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
