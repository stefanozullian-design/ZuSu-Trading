import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, UnconfiguredProvider } from './anthropic-provider.js';
import { AnalysisError, type CompletionRequest } from './types.js';

/**
 * The Anthropic adapter, against a fake transport.
 *
 * No key exists on this deployment, so nothing here has touched the real API.
 * These tests pin the request shape, the error mapping and the refusal to
 * accept a reply that cannot be costed — the three things a first real call is
 * most likely to get wrong quietly.
 */

const request: CompletionRequest = {
  model: 'claude-haiku-4-5',
  system: 'You screen symbols.',
  user: '{"symbols":["AAPL"]}',
  maxOutputTokens: 500,
  thinking: 'off',
};

function transport(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const goodBody = {
  model: 'claude-haiku-4-5',
  content: [{ type: 'text', text: '{"shortlist":[]}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 120, output_tokens: 40 },
};

describe('the request it sends', () => {
  it('puts the key in a header, never in the URL', async () => {
    const { fetchImpl, calls } = transport(200, goodBody);
    const provider = new AnthropicProvider({ apiKey: 'sk-test-key', fetchImpl });

    await provider.complete(request);

    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    // A URL ends up in logs, proxies and error reports; a header does not.
    expect(call.url).not.toContain('sk-test-key');
    expect((call.init.headers as Record<string, string>)['x-api-key']).toBe('sk-test-key');
    expect((call.init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
  });

  it('sends the system prompt separately from the user content', async () => {
    const { fetchImpl, calls } = transport(200, goodBody);
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });

    await provider.complete(request);

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.system).toBe('You screen symbols.');
    expect(body.messages).toEqual([{ role: 'user', content: '{"symbols":["AAPL"]}' }]);
    expect(body.max_tokens).toBe(500);
    // Never sent. The current models reject sampling parameters outright — a
    // `temperature` on Opus 5 or Sonnet 5 is a 400, so an adapter that sends
    // one cannot complete a single call.
    expect(body.temperature).toBeUndefined();
    // A screen is a classification and does not reason first.
    expect(body.thinking).toBeUndefined();
  });
});

describe('what it does with a reply', () => {
  it('returns the text with its usage and latency', async () => {
    const { fetchImpl } = transport(200, goodBody);
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });

    const response = await provider.complete(request);

    expect(response.text).toBe('{"shortlist":[]}');
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
    expect(response.stopReason).toBe('end_turn');
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('joins several text blocks rather than taking the first', async () => {
    const { fetchImpl } = transport(200, {
      ...goodBody,
      content: [
        { type: 'text', text: 'part one' },
        { type: 'text', text: 'part two' },
      ],
    });
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });

    expect((await provider.complete(request)).text).toBe('part one\npart two');
  });

  it('refuses a reply it cannot cost', async () => {
    const { fetchImpl } = transport(200, { ...goodBody, usage: undefined });
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });

    // Spend that cannot be measured cannot be capped, which is the failure
    // mode this module exists to prevent.
    await expect(provider.complete(request)).rejects.toThrow(/cannot be costed/);
  });

  it('refuses a reply with no text', async () => {
    const { fetchImpl } = transport(200, { ...goodBody, content: [] });
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });

    await expect(provider.complete(request)).rejects.toThrow(/no text content/);
  });

  it('refuses a body that is not JSON', async () => {
    const { fetchImpl } = transport(200, '<html>gateway</html>');
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });

    await expect(provider.complete(request)).rejects.toThrow(/not JSON/);
  });
});

describe('errors', () => {
  it('marks a rate limit and a server fault retryable', async () => {
    for (const status of [429, 500, 503]) {
      const { fetchImpl } = transport(status, { error: { message: 'slow down' } });
      const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });

      await expect(provider.complete(request)).rejects.toMatchObject({
        name: 'AnalysisError',
        retryable: true,
        status,
      });
    }
  });

  it('marks a bad request not retryable, because sending it again is the same request', async () => {
    const { fetchImpl } = transport(400, { error: { message: 'max_tokens is required' } });
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });

    await expect(provider.complete(request)).rejects.toMatchObject({
      retryable: false,
      status: 400,
    });
  });

  it('carries the provider’s message so a failure is diagnosable', async () => {
    const { fetchImpl } = transport(400, { error: { message: 'model: unknown model' } });
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });

    await expect(provider.complete(request)).rejects.toThrow(/unknown model/);
  });

  it('treats a transport failure as retryable', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('socket hang up')),
    ) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });

    await expect(provider.complete(request)).rejects.toMatchObject({ retryable: true });
  });
});

describe('without a key', () => {
  it('reports itself unconfigured rather than calling', async () => {
    const provider = new AnthropicProvider({ apiKey: '' });

    expect(provider.isConfigured()).toBe(false);
    await expect(provider.complete(request)).rejects.toThrow(/No Anthropic API key/);
  });

  it('the unconfigured provider refuses instead of inventing an answer', async () => {
    const provider = new UnconfiguredProvider();

    expect(provider.isConfigured()).toBe(false);
    // A fabricated analysis is worse than none: a reader cannot tell.
    await expect(provider.complete()).rejects.toThrow(/will not substitute/);
    await expect(provider.complete()).rejects.toBeInstanceOf(AnalysisError);
  });
});

describe('reasoning', () => {
  it('asks for adaptive thinking when the caller wants it', async () => {
    const { fetchImpl, calls } = transport(200, goodBody);
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });

    await provider.complete({ ...request, thinking: 'adaptive' });

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    // Depth is controlled by thinking now, not by sampling.
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.temperature).toBeUndefined();
  });
});
