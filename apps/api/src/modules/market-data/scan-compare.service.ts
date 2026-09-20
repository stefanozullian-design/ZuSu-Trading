import type { PrismaClient } from '@prisma/client';
import { type Finding, dec, riskProfileFor } from '@zusu/shared';
import type { CompositionService } from '../portfolios/composition.service.js';
import type { Principal } from '../rbac/access-control.js';
import type { ScanService } from './scan.service.js';

/**
 * Several saved scans, side by side.
 *
 * Every screening view in this platform used to be organised *by method*: pick
 * a scan, run it, read its list. Comparing two meant running one, remembering
 * it, and running the other — so the one fact worth having was the one nobody
 * ever had.
 *
 * That fact is **agreement**. A symbol three independent filters flag is a
 * different proposition from one that scraped through a single screen, and no
 * amount of staring at one list at a time produces it. This inverts the axis:
 * symbols are the rows, methods are the columns, and the count of methods that
 * flagged each symbol is what it sorts by.
 *
 * Two deliberate refusals:
 *
 *   - **A broken scan does not sink the comparison.** A saved scan whose
 *     conditions no longer validate is reported in its own column with the
 *     reason, and the other columns still run. The alternative is that one bad
 *     filter hides every result from the good ones.
 *
 *   - **Agreement is never presented as quality.** Three scans that all test
 *     momentum are one opinion stated three times, and the count cannot tell
 *     the difference. The number is what it is — how many of *these* filters
 *     matched — and the wording says so rather than implying a verdict.
 */

export interface MethodColumn {
  scanId: string;
  name: string;
  timeframe: string;
  /** Each condition in words, so a column is readable without opening it. */
  summary: string[];
  matched: number;
  evaluated: number;
  /** Symbols this method could not judge — never silently dropped. */
  notEvaluable: { symbol: string; reason: string }[];
  /** Set when this scan could not run at all. Its column is empty, not absent. */
  error: string | null;
}

export interface ComparisonRow {
  symbol: string;
  name: string | null;
  sector: string | null;
  /** Scan ids that flagged it, in the order the columns are returned. */
  flaggedBy: string[];
  /** How many of the chosen methods matched. The sort key. */
  agreement: number;
  /** Every field value the matching conditions referenced, for auditability. */
  values: Record<string, string>;
  /** Whether the named portfolio already holds it. */
  held: boolean;
  /** Its weight in that portfolio today, when held and priced. */
  heldPct: string | null;
  /** What the portfolio already has in this symbol's sector. */
  sectorPct: string | null;
  /** Why it would or would not complement what is already held. */
  fit: Finding[];
}

export interface Comparison {
  ranAt: string;
  methods: MethodColumn[];
  rows: ComparisonRow[];
  /** The portfolio the fit column was measured against, if any. */
  portfolioId: string | null;
  /** Said plainly, because agreement invites being read as a score. */
  caveats: string[];
}

const CAVEATS = [
  'Agreement counts how many of the filters you chose matched a symbol. It is not a score, and it is not advice.',
  'Filters that test the same idea agree with each other by construction. Three momentum screens are one opinion stated three times.',
  'A symbol missing from a column was either judged and did not match, or could not be judged at all. The method’s own list says which.',
];

export class ScanCompareService {
  constructor(
    private readonly db: PrismaClient,
    private readonly scans: ScanService,
    private readonly composition: CompositionService,
  ) {}

  async compare(
    principal: Principal,
    input: { scanIds: string[]; portfolioId?: string | null; barLimit?: number },
  ): Promise<Comparison> {
    const methods: MethodColumn[] = [];
    const matchesBySymbol = new Map<
      string,
      { scanIds: string[]; values: Record<string, string> }
    >();

    for (const scanId of input.scanIds) {
      try {
        const definition = await this.scans.get(scanId);
        const result = await this.scans.runSaved(scanId, {
          ...(input.barLimit === undefined ? {} : { barLimit: input.barLimit }),
        });

        methods.push({
          scanId,
          name: definition.name,
          timeframe: definition.timeframe,
          summary: result.summary,
          matched: result.matches.length,
          evaluated: result.evaluated,
          notEvaluable: result.notEvaluable.map((skip) => ({
            symbol: skip.symbol,
            reason: skip.reason,
          })),
          error: null,
        });

        for (const match of result.matches) {
          const existing = matchesBySymbol.get(match.symbol) ?? { scanIds: [], values: {} };
          existing.scanIds.push(scanId);
          // Later columns do not overwrite earlier ones: the same field read
          // on two timeframes is two different numbers, and silently keeping
          // the last would attribute one method's reading to another.
          for (const [field, value] of Object.entries(match.values)) {
            existing.values[field] ??= value;
          }
          matchesBySymbol.set(match.symbol, existing);
        }
      } catch (error) {
        // One unreadable saved scan must not hide every result from the rest.
        const row = await this.db.scanDefinition.findUnique({ where: { id: scanId } });
        methods.push({
          scanId,
          name: row?.name ?? 'Unknown scan',
          timeframe: row?.timeframe ?? '—',
          summary: [],
          matched: 0,
          evaluated: 0,
          notEvaluable: [],
          error: error instanceof Error ? error.message : 'This scan could not run',
        });
      }
    }

    const symbols = [...matchesBySymbol.keys()];
    const instruments = await this.db.instrument.findMany({
      where: { symbol: { in: symbols } },
      select: { symbol: true, name: true, sector: true },
    });
    const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));

    const held = await this.heldContext(principal, input.portfolioId ?? null);

    const rows: ComparisonRow[] = symbols
      .map((symbol) => {
        const hit = matchesBySymbol.get(symbol) as {
          scanIds: string[];
          values: Record<string, string>;
        };
        const sector = bySymbol.get(symbol)?.sector ?? null;
        const weight = held?.weights.get(symbol) ?? null;
        const sectorPct = sector === null ? null : (held?.sectors.get(sector) ?? null);

        return {
          symbol,
          name: bySymbol.get(symbol)?.name ?? null,
          sector,
          flaggedBy: hit.scanIds,
          agreement: hit.scanIds.length,
          values: hit.values,
          held: weight !== null,
          heldPct: weight,
          sectorPct,
          fit:
            held === null ? [] : fitFor({ symbol, sector, weight, sectorPct, limits: held.limits }),
        };
      })
      // Agreement first, then the larger existing sector position — a reader
      // scanning this column downwards meets the most-corroborated names
      // before anything else, which is the whole reason for the view.
      .sort((a, b) => b.agreement - a.agreement || a.symbol.localeCompare(b.symbol));

    return {
      ranAt: new Date().toISOString(),
      methods,
      rows,
      portfolioId: input.portfolioId ?? null,
      caveats: CAVEATS,
    };
  }

  /** Weights and sector weights of what a portfolio already holds. */
  private async heldContext(
    principal: Principal,
    portfolioId: string | null,
  ): Promise<{
    weights: Map<string, string>;
    sectors: Map<string, string>;
    limits: { symbol: number; sector: number };
  } | null> {
    if (portfolioId === null) return null;

    const view = await this.composition.forPortfolio(principal, portfolioId);
    const profile = await this.db.portfolio.findUniqueOrThrow({
      where: { id: portfolioId },
      select: { objective: true },
    });
    const limits = riskProfileFor(profile.objective);

    return {
      weights: new Map(
        view.bySymbol.filter((w) => w.pct !== null).map((w) => [w.key, w.pct as string]),
      ),
      sectors: new Map(
        view.bySector.filter((w) => w.pct !== null).map((w) => [w.key, w.pct as string]),
      ),
      limits: { symbol: limits.maxSymbolExposurePct, sector: limits.maxSectorExposurePct },
    };
  }
}

/**
 * Whether a candidate would complement what is already held.
 *
 * Complementing is mostly about what a holding would *add* that is not already
 * there, and the two things this can check honestly are whether the portfolio
 * already owns it and whether its sector is already full. It deliberately does
 * not score "fit" — a single number would hide which of those two it meant.
 */
function fitFor(input: {
  symbol: string;
  sector: string | null;
  weight: string | null;
  sectorPct: string | null;
  limits: { symbol: number; sector: number };
}): Finding[] {
  const fit: Finding[] = [];

  if (input.weight !== null) {
    const weight = dec(input.weight);
    const over = weight.greaterThanOrEqualTo(input.limits.symbol);
    fit.push({
      code: 'ALREADY_HELD',
      severity: over ? 'BREACH' : 'INFO',
      title: `Already ${weight.toFixed(1)}% of this portfolio`,
      detail: over
        ? `This is at or past the ${String(input.limits.symbol)}% single-name limit. Buying more ` +
          'concentrates what is already the largest bet rather than adding anything.'
        : 'Buying more adds to an existing position rather than a new one. That is a different ' +
          'decision from opening one, and not necessarily a worse one.',
      subject: input.symbol,
    });
  }

  if (input.sector !== null && input.sectorPct !== null) {
    const sectorWeight = dec(input.sectorPct);
    if (sectorWeight.greaterThanOrEqualTo(input.limits.sector)) {
      fit.push({
        code: 'SECTOR_FULL',
        severity: 'BREACH',
        title: `${input.sector} is already ${sectorWeight.toFixed(1)}% of the portfolio`,
        detail:
          `The limit for one sector here is ${String(input.limits.sector)}%. Whatever this ` +
          'symbol’s own merits, adding it makes the portfolio more like one bet, not less.',
        subject: input.sector,
      });
    } else if (sectorWeight.greaterThan(input.limits.sector * 0.75)) {
      fit.push({
        code: 'SECTOR_NEARLY_FULL',
        severity: 'WATCH',
        title: `${input.sector} is ${sectorWeight.toFixed(1)}% of a ${String(input.limits.sector)}% allowance`,
        detail: 'There is room for a small position here and not a large one.',
        subject: input.sector,
      });
    }
  }

  if (fit.length === 0) {
    fit.push({
      code: 'ADDS_SOMETHING_NEW',
      severity: 'INFO',
      title:
        input.sector === null
          ? 'Not held, and its sector is not recorded'
          : `Not held, and ${input.sector} has room`,
      detail:
        'This would open a new position rather than deepen one. Whether it is a good idea is ' +
        'a separate question from whether it fits.',
      subject: input.symbol,
    });
  }

  return fit;
}
