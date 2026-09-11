export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Single-flight refresh so a burst of 401s produces one rotation, not many. */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      return res.ok;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so concurrent callers share this attempt.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();
  return refreshInFlight;
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Internal: prevents an infinite refresh loop. */
  retried?: boolean;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);

  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (!SAFE_METHODS.has(method)) {
    const csrf = readCookie('zusu_csrf');
    if (csrf) headers.set('x-csrf-token', csrf);
  }

  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 401 && !options.retried && path !== '/api/auth/refresh') {
    if (await refreshSession()) return api<T>(path, { ...options, retried: true });
  }

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const err = (payload as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
    throw new ApiError(
      err?.code ?? 'UNKNOWN',
      err?.message ?? `Request failed with status ${response.status}`,
      response.status,
      err?.details,
    );
  }

  return payload as T;
}
