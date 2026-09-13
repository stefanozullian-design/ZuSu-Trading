import { z } from 'zod';
import {
  AssetClass,
  ExecutionMode,
  OrderSide,
  OrderStatus,
  OrderType,
  PortfolioObjective,
  ServiceStatus,
  TimeInForce,
  TradingEnvironment,
  TradingState,
  UserRole,
} from './enums.js';

/** Keeps the literal union type instead of widening every member to `string`. */
const enumValues = <T extends Record<string, string>>(e: T) =>
  Object.values(e) as [T[keyof T], ...T[keyof T][]];

export const tradingEnvironmentSchema = z.enum(enumValues(TradingEnvironment));
export const userRoleSchema = z.enum(enumValues(UserRole));
export const executionModeSchema = z.enum(enumValues(ExecutionMode));
export const tradingStateSchema = z.enum(enumValues(TradingState));
export const orderSideSchema = z.enum(enumValues(OrderSide));
export const orderTypeSchema = z.enum(enumValues(OrderType));
export const orderStatusSchema = z.enum(enumValues(OrderStatus));
export const timeInForceSchema = z.enum(enumValues(TimeInForce));
export const assetClassSchema = z.enum(enumValues(AssetClass));
export const serviceStatusSchema = z.enum(enumValues(ServiceStatus));

/** Decimal-as-string. Rejects floats to keep money out of IEEE-754. */
export const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a decimal number encoded as a string');

export const positiveDecimalString = decimalString.refine(
  (v) => Number(v) > 0,
  'must be greater than zero',
);

export const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .regex(/^[A-Z0-9.\-/:]+$/, 'symbol must be upper-case alphanumeric');

export const passwordSchema = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(200)
  .refine((v) => /[a-z]/.test(v), 'password must contain a lower-case letter')
  .refine((v) => /[A-Z]/.test(v), 'password must contain an upper-case letter')
  .refine((v) => /\d/.test(v), 'password must contain a digit');

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'authenticator code must be 6 digits');

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
  /** Optional on the first call: the server replies with `mfaRequired`. */
  totp: totpCodeSchema.optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authenticatedUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  role: userRoleSchema,
  mfaEnabled: z.boolean(),
  permissions: z.array(z.string()),
  /** Portfolios this principal may read. Empty for an admin (= all). */
  portfolioIds: z.array(z.string().uuid()),
});
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

export const loginResponseSchema = z.union([
  z.object({
    status: z.literal('MFA_REQUIRED'),
    /** Short-lived proof that the password step succeeded. */
    mfaToken: z.string(),
  }),
  z.object({
    /** The role mandates MFA but the user has not enrolled yet. */
    status: z.literal('MFA_ENROLMENT_REQUIRED'),
    mfaToken: z.string(),
  }),
  z.object({
    status: z.literal('AUTHENTICATED'),
    user: authenticatedUserSchema,
    csrfToken: z.string(),
    accessTokenExpiresAt: z.string().datetime(),
  }),
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const mfaVerifyRequestSchema = z.object({
  mfaToken: z.string().min(1),
  totp: totpCodeSchema,
});

export const mfaEnrollResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  qrDataUrl: z.string(),
});

export const mfaActivateRequestSchema = z.object({ totp: totpCodeSchema });

// ---------------------------------------------------------------------------
// Clients & portfolios
// ---------------------------------------------------------------------------

export const createClientSchema = z.object({
  name: z.string().trim().min(2).max(120),
  externalRef: z.string().trim().max(64).optional(),
  contactEmail: z.string().trim().toLowerCase().email().optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * Editing an owner.
 *
 * `externalRef` and `contactEmail` are nullable rather than merely optional:
 * a reference typed by mistake has to be removable, and a field that can only
 * be set and never cleared makes every slip permanent.
 */
export const updateClientSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    externalRef: z.string().trim().max(64).nullable(),
    contactEmail: z.string().trim().toLowerCase().email().nullable(),
    notes: z.string().max(2000).nullable(),
    isActive: z.boolean(),
  })
  .partial();
export type UpdateClientInput = z.infer<typeof updateClientSchema>;

export const riskLimitsSchema = z.object({
  maxDailyLoss: decimalString,
  maxWeeklyLoss: decimalString,
  maxPositionSize: decimalString,
  maxPortfolioExposurePct: decimalString,
  maxSectorExposurePct: decimalString,
  maxSymbolExposurePct: decimalString,
  maxOpenPositions: z.number().int().min(0).max(1000),
  maxTradesPerDay: z.number().int().min(0).max(10000),
  maxConsecutiveLosses: z.number().int().min(0).max(1000),
  maxDrawdownPct: decimalString,
});
export type RiskLimitsInput = z.infer<typeof riskLimitsSchema>;

export const portfolioObjectiveSchema = z.enum(enumValues(PortfolioObjective));

export const createPortfolioSchema = z.object({
  name: z.string().trim().min(2).max(120),
  environment: tradingEnvironmentSchema,
  /** The person whose money this is. Absent means unassigned, never "mine". */
  clientId: z.string().uuid().optional(),
  /** What the money is for; selects the starting risk limits. */
  objective: portfolioObjectiveSchema.optional(),
  baseCurrency: z.string().trim().length(3).default('USD'),
  initialCapital: positiveDecimalString,
  executionMode: executionModeSchema.default(ExecutionMode.MANUAL_APPROVAL),
  riskLimits: riskLimitsSchema.partial().optional(),
});
export type CreatePortfolioInput = z.infer<typeof createPortfolioSchema>;

export const updatePortfolioSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    executionMode: executionModeSchema,
    isActive: z.boolean(),
    /**
     * Both of these are nullable rather than merely optional: "no owner" and
     * "no stated objective" are answers a person can give, and a field that
     * can only be set and never cleared makes a mis-assignment permanent.
     */
    clientId: z.string().uuid().nullable(),
    objective: portfolioObjectiveSchema.nullable(),
  })
  .partial();

export const portfolioSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  environment: tradingEnvironmentSchema,
  clientId: z.string().uuid().nullable(),
  clientName: z.string().nullable(),
  objective: portfolioObjectiveSchema.nullable(),
  baseCurrency: z.string(),
  executionMode: executionModeSchema,
  tradingState: tradingStateSchema,
  isActive: z.boolean(),
  cashBalance: decimalString,
  positionsValue: decimalString.nullable(),
  equity: decimalString.nullable(),
  initialCapital: decimalString,
  /** Null until a prior snapshot exists to measure the day against. */
  dailyPnl: decimalString.nullable(),
  dailyPnlPct: decimalString.nullable(),
  openPositions: z.number().int(),
  dailyRiskUsedPct: decimalString.nullable(),
  killSwitchEngaged: z.boolean(),
});
export type PortfolioSummary = z.infer<typeof portfolioSummarySchema>;

export const positionSchema = z.object({
  id: z.string().uuid(),
  portfolioId: z.string().uuid(),
  symbol: z.string(),
  assetClass: assetClassSchema,
  quantity: decimalString,
  averageEntryPrice: decimalString,
  /** Null when no market-data provider is available for the environment. */
  markPrice: decimalString.nullable(),
  marketValue: decimalString.nullable(),
  unrealizedPnl: decimalString.nullable(),
  realizedPnl: decimalString,
  openedAt: z.string().datetime(),
});
export type PositionDto = z.infer<typeof positionSchema>;

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

export const killSwitchRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  /** Omit to halt every portfolio the caller can reach. */
  portfolioId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

export const serviceHealthSchema = z.object({
  service: z.string(),
  status: serviceStatusSchema,
  lastHeartbeatAt: z.string().datetime().nullable(),
  latencyMs: z.number().nullable(),
  detail: z.string().nullable(),
});

export const systemHealthSchema = z.object({
  environment: tradingEnvironmentSchema,
  overall: serviceStatusSchema,
  tradingEnabled: z.boolean(),
  services: z.array(serviceHealthSchema),
  checkedAt: z.string().datetime(),
});
export type SystemHealth = z.infer<typeof systemHealthSchema>;

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const auditQuerySchema = z.object({
  portfolioId: z.string().uuid().optional(),
  action: z.string().max(64).optional(),
  actorId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
