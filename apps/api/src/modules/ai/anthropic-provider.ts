import {
  AnalysisError,
  type AnalysisProvider,
  type CompletionRequest,
  type CompletionResponse,
} from './types.js';

/**
 * Anthropic Messages API adapter.
 *
 * Built on `fetch` rather than the vendor SDK, for the same reasons the
 * market-data adapter is: an injection point for a fake transport, the HTTP
 * status visible rather than wrapped, and no dependency that can change its
 * retry behaviour underneath us.
 *
 * **Not yet verified against the live API.** This deployment has no
 * `ANTHROPIC_API_KEY`, so every test below runs against a fake transport that
 * replays recorded response shapes. The request shape, the error mapping and
 * the usage accounting are all written from the documented API, and the first
 * real call may still find something this does not handle. That is stated here
 * rather than discovered by someone assuming it was tested.
 */

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injection point for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  model?: string;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicProvider implements AnalysisProvider {
  readonly name = 'anthropic';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.isConfigured()) {
      throw new AnalysisError('No Anthropic API key is configured', false);
    }

    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          // The key goes in a header, never a query string: a URL ends up in
          // logs, proxies and error reports.
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // A timeout or a socket failure is retryable; the caller decides whether
      // to, and a retry is never silent.
      throw new AnalysisError(
        error instanceof Error ? error.message : 'the request failed before a reply',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }

    const latencyMs = Date.now() - started;
    const bodyText = await response.text();

    if (!response.ok) {
      // 429 and 5xx are worth retrying; a 400 means the request was wrong and
      // sending it again would be wrong again.
      const retryable = response.status === 429 || response.status >= 500;
      throw new AnalysisError(
        `Anthropic returned ${String(response.status)}: ${bodyText.slice(0, 400)}`,
        retryable,
        response.status,
      );
    }

    let parsed: MessagesResponse;
    try {
      parsed = JSON.parse(bodyText) as MessagesResponse;
    } catch {
      throw new AnalysisError('Anthropic returned a body that is not JSON', false, response.status);
    }

    const text = (parsed.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();

    if (text.length === 0) {
      throw new AnalysisError('Anthropic returned no text content', false, response.status);
    }

    const inputTokens = parsed.usage?.input_tokens;
    const outputTokens = parsed.usage?.output_tokens;
    if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
      // Usage is not optional here: spend that cannot be measured cannot be
      // capped, and an uncapped spend is the failure mode this platform cares
      // about most in this module.
      throw new AnalysisError(
        'Anthropic reported no token usage, so this call cannot be costed',
        false,
        response.status,
      );
    }

    return {
      text,
      model: parsed.model ?? request.model,
      usage: { inputTokens, outputTokens },
      latencyMs,
      stopReason: parsed.stop_reason ?? null,
    };
  }
}

/**
 * A provider that refuses every call, used when no key is configured.
 *
 * Deliberately not a stub that returns plausible text: a fake analysis is
 * worse than none, because a person reading it cannot tell. The refusal names
 * the missing key so the reason is obvious.
 */
export class UnconfiguredProvider implements AnalysisProvider {
  readonly name = 'unconfigured';

  isConfigured(): boolean {
    return false;
  }

  complete(): Promise<CompletionResponse> {
    return Promise.reject(
      new AnalysisError(
        'No ANTHROPIC_API_KEY is configured, so no analysis can be run. ' +
          'This platform will not substitute a plausible-looking answer.',
        false,
      ),
    );
  }
}
