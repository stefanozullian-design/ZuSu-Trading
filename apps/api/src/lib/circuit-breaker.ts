/**
 * Circuit breaker (§56).
 *
 * After a run of failures the breaker opens and calls fail fast instead of
 * piling retries onto a service that is already struggling. A single trial call
 * is allowed once the cool-down elapses.
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number;
  /** Milliseconds the breaker stays open before allowing a trial call. */
  resetTimeoutMs?: number;
  /** Successes required in HALF_OPEN before closing again. */
  successThreshold?: number;
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor(
    name: string,
    readonly retryAfterMs: number,
  ) {
    super(`Circuit "${name}" is open; not calling the dependency for another ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly now: () => number;

  private state: BreakerState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private lastError: string | null = null;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 2;
    this.now = options.now ?? (() => Date.now());
  }

  get status(): { state: BreakerState; failures: number; lastError: string | null } {
    return { state: this.currentState(), failures: this.failures, lastError: this.lastError };
  }

  private currentState(): BreakerState {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = 'HALF_OPEN';
      this.successes = 0;
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState();
    if (state === 'OPEN') {
      throw new CircuitOpenError(this.name, this.resetTimeoutMs - (this.now() - this.openedAt));
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    this.lastError = null;
    if (this.state === 'HALF_OPEN') {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failures = 0;
      }
      return;
    }
    this.failures = 0;
  }

  private onFailure(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = this.now();
    }
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.lastError = null;
  }
}
