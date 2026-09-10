import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

function harness(options: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  let now = 0;
  const breaker = new CircuitBreaker({
    name: 'test',
    failureThreshold: 3,
    resetTimeoutMs: 1_000,
    successThreshold: 2,
    now: () => now,
    ...options,
  });
  return { breaker, advance: (ms: number) => (now += ms) };
}

const fail = () => Promise.reject(new Error('dependency down'));
const ok = () => Promise.resolve('value');

describe('CircuitBreaker', () => {
  it('stays closed while calls succeed', async () => {
    const { breaker } = harness();
    expect(await breaker.execute(ok)).toBe('value');
    expect(breaker.status.state).toBe('CLOSED');
  });

  it('opens after the failure threshold and then fails fast', async () => {
    const { breaker } = harness();
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(fail)).rejects.toThrow('dependency down');
    }
    expect(breaker.status.state).toBe('OPEN');

    // The dependency is no longer called at all — no retry storm (§54).
    let called = false;
    await expect(
      breaker.execute(async () => {
        called = true;
        return 'value';
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it('probes once after the cool-down and closes on sustained success', async () => {
    const { breaker, advance } = harness();
    for (let i = 0; i < 3; i += 1) await breaker.execute(fail).catch(() => undefined);

    advance(1_000);
    expect(breaker.status.state).toBe('HALF_OPEN');
    await breaker.execute(ok);
    expect(breaker.status.state).toBe('HALF_OPEN');
    await breaker.execute(ok);
    expect(breaker.status.state).toBe('CLOSED');
  });

  it('reopens immediately when the probe fails again', async () => {
    const { breaker, advance } = harness();
    for (let i = 0; i < 3; i += 1) await breaker.execute(fail).catch(() => undefined);
    advance(1_000);
    await breaker.execute(fail).catch(() => undefined);
    expect(breaker.status.state).toBe('OPEN');
  });

  it('records the last error for the health panel', async () => {
    const { breaker } = harness();
    await breaker.execute(fail).catch(() => undefined);
    expect(breaker.status.lastError).toBe('dependency down');
  });
});
