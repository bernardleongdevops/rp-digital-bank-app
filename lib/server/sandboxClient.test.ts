/**
 * Unit tests for `lib/server/sandboxClient.ts` — task 4.5.
 *
 * Covers timeout/abort handling and `Error_Body` normalization:
 *  - `normalizeResponse`: 2xx -> OK; 401 -> UNAUTHENTICATED; 429 -> RATE_LIMITED;
 *    other non-ok -> ERROR/HTTP (status + error code); 403 CORS/origin ->
 *    ORIGIN_NOT_PERMITTED; 2xx with unparseable body -> ERROR/UNEXPECTED.
 *  - `mapTransferResponse`: 201/202/422/409/403/401/429/other.
 *  - `sandboxFetch`: missing credential -> UNAUTHENTICATED with no outbound call;
 *    abort -> TIMEOUT; non-abort throw -> NETWORK; `Error_Body` normalization
 *    forwards only `status` + `error` code.
 *  - `createTransfer`: enforces the 30s timeout; abort -> TIMEOUT; other throw
 *    -> NETWORK; missing credential -> ERROR/UNEXPECTED (no outbound call).
 *
 * All dependencies (token/config/fetch) are injected via `SandboxDeps`, so no
 * real session, config, or network is exercised. No request reaches the live
 * Sandbox_Gateway (Requirement 11.1).
 *
 * _Requirements: 6.6, 6.7, 8.3_
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTransfer,
  mapTransferResponse,
  normalizeResponse,
  sandboxFetch,
  TRANSFER_TIMEOUT_MS,
  type SandboxConfig,
  type SandboxDeps,
} from '@/lib/server/sandboxClient';
import type { TransferRequest } from '@/lib/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const CONFIG: SandboxConfig = {
  sandboxApiBaseUrl: 'http://localhost:8081/api/v1',
  sandboxApiKey: 'test-sandbox-key',
};

/** Build injectable deps with sensible defaults, overridable per test. */
function makeDeps(overrides: Partial<SandboxDeps> = {}): SandboxDeps {
  return {
    getAccessToken: async () => 'test-access-token',
    getSandboxConfig: () => CONFIG,
    fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })),
    ...overrides,
  };
}

/** Construct a JSON `Response` with the given status. */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** An `AbortError` matching what `AbortController.abort()` raises. */
function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

const TRANSFER_BODY: TransferRequest = {
  fromAccount: 'ACC-1001',
  toAccount: 'ACC-1002',
  amount: 100.5,
  description: 'test transfer',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// (a) normalizeResponse
// ---------------------------------------------------------------------------

describe('normalizeResponse', () => {
  it('maps a 2xx response to OK with the parsed data', async () => {
    const data = { accountNumber: 'ACC-1001', balance: 5000 };
    const result = await normalizeResponse<typeof data>(jsonResponse(data, 200));
    expect(result).toEqual({ kind: 'OK', data });
  });

  it('maps a 201 response to OK with the parsed data', async () => {
    const data = [{ id: 'T1' }];
    const result = await normalizeResponse<typeof data>(jsonResponse(data, 201));
    expect(result).toEqual({ kind: 'OK', data });
  });

  it('maps 401 to UNAUTHENTICATED', async () => {
    const result = await normalizeResponse(jsonResponse({ status: 401, error: 'UNAUTHORIZED' }, 401));
    expect(result).toEqual({ kind: 'UNAUTHENTICATED' });
  });

  it('maps 429 to RATE_LIMITED', async () => {
    const result = await normalizeResponse(jsonResponse({ status: 429, error: 'RATE_LIMITED' }, 429));
    expect(result).toEqual({ kind: 'RATE_LIMITED' });
  });

  it('maps a generic non-ok status to ERROR/HTTP forwarding status + error code only', async () => {
    const result = await normalizeResponse(
      jsonResponse({ status: 500, error: 'INTERNAL_ERROR', message: 'boom', path: '/x' }, 500),
    );
    expect(result).toEqual({ kind: 'ERROR', reason: 'HTTP', status: 500, error: 'INTERNAL_ERROR' });
    // The human message / path must NOT be forwarded (Requirement 6.7).
    expect(result).not.toHaveProperty('message');
    expect(result).not.toHaveProperty('path');
  });

  it('maps a non-ok status with no parseable error code to ERROR/HTTP with undefined error', async () => {
    const result = await normalizeResponse(new Response('not json', { status: 503 }));
    expect(result).toEqual({ kind: 'ERROR', reason: 'HTTP', status: 503, error: undefined });
  });

  it('maps a 403 CORS/origin denial to ERROR/HTTP with ORIGIN_NOT_PERMITTED', async () => {
    const result = await normalizeResponse(jsonResponse({ status: 403, error: 'CORS_ORIGIN_DENIED' }, 403));
    expect(result).toEqual({
      kind: 'ERROR',
      reason: 'HTTP',
      status: 403,
      error: 'ORIGIN_NOT_PERMITTED',
    });
  });

  it('maps a 403 whose error code names the origin to ORIGIN_NOT_PERMITTED', async () => {
    const result = await normalizeResponse(jsonResponse({ status: 403, error: 'ORIGIN_NOT_ALLOWED' }, 403));
    expect(result).toEqual({
      kind: 'ERROR',
      reason: 'HTTP',
      status: 403,
      error: 'ORIGIN_NOT_PERMITTED',
    });
  });

  it('maps a plain 403 (not CORS/origin) to ERROR/HTTP forwarding the original error code', async () => {
    const result = await normalizeResponse(jsonResponse({ status: 403, error: 'FORBIDDEN' }, 403));
    expect(result).toEqual({ kind: 'ERROR', reason: 'HTTP', status: 403, error: 'FORBIDDEN' });
  });

  it('maps a 2xx with an unparseable body to ERROR/UNEXPECTED with the status', async () => {
    const result = await normalizeResponse(new Response('<<not json>>', { status: 200 }));
    expect(result).toEqual({ kind: 'ERROR', reason: 'UNEXPECTED', status: 200 });
  });
});

// ---------------------------------------------------------------------------
// (b) mapTransferResponse
// ---------------------------------------------------------------------------

describe('mapTransferResponse', () => {
  it('maps 201 to COMPLETED', async () => {
    expect(await mapTransferResponse(jsonResponse({}, 201))).toEqual({ kind: 'COMPLETED', status: 201 });
  });

  it('maps 202 to AML_HELD', async () => {
    expect(await mapTransferResponse(jsonResponse({}, 202))).toEqual({ kind: 'AML_HELD', status: 202 });
  });

  it('maps 422 to AML_BLOCKED', async () => {
    expect(await mapTransferResponse(jsonResponse({}, 422))).toEqual({ kind: 'AML_BLOCKED', status: 422 });
  });

  it('maps 409 to CONFLICT carrying the error code and message', async () => {
    const res = jsonResponse({ status: 409, error: 'INSUFFICIENT_FUNDS', message: 'Not enough funds' }, 409);
    expect(await mapTransferResponse(res)).toEqual({
      kind: 'CONFLICT',
      status: 409,
      error: 'INSUFFICIENT_FUNDS',
      message: 'Not enough funds',
    });
  });

  it('maps 409 with no body to CONFLICT with fallback error and empty message', async () => {
    const res = new Response('not json', { status: 409 });
    expect(await mapTransferResponse(res)).toEqual({
      kind: 'CONFLICT',
      status: 409,
      error: 'CONFLICT',
      message: '',
    });
  });

  it('maps 403 to FORBIDDEN', async () => {
    expect(await mapTransferResponse(jsonResponse({}, 403))).toEqual({ kind: 'FORBIDDEN', status: 403 });
  });

  it('maps 401 to UNAUTHENTICATED', async () => {
    expect(await mapTransferResponse(jsonResponse({}, 401))).toEqual({ kind: 'UNAUTHENTICATED', status: 401 });
  });

  it('maps 429 to RATE_LIMITED', async () => {
    expect(await mapTransferResponse(jsonResponse({}, 429))).toEqual({ kind: 'RATE_LIMITED', status: 429 });
  });

  it('maps any other status to ERROR/UNEXPECTED with the status', async () => {
    expect(await mapTransferResponse(jsonResponse({}, 500))).toEqual({
      kind: 'ERROR',
      reason: 'UNEXPECTED',
      status: 500,
    });
    expect(await mapTransferResponse(jsonResponse({}, 200))).toEqual({
      kind: 'ERROR',
      reason: 'UNEXPECTED',
      status: 200,
    });
  });
});

// ---------------------------------------------------------------------------
// (c) sandboxFetch — missing credentials short-circuit without fetching
// ---------------------------------------------------------------------------

describe('sandboxFetch credential guard', () => {
  it('returns UNAUTHENTICATED without calling fetch when the token is missing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 200));
    const deps = makeDeps({ getAccessToken: async () => undefined, fetchImpl });

    const result = await sandboxFetch('/customers/me', { method: 'GET' }, {}, deps);

    expect(result).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns UNAUTHENTICATED without calling fetch when the API key is missing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 200));
    const deps = makeDeps({
      getSandboxConfig: () => ({ ...CONFIG, sandboxApiKey: '' }),
      fetchImpl,
    });

    const result = await sandboxFetch('/customers/me', { method: 'GET' }, {}, deps);

    expect(result).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (c/d) sandboxFetch — normalization + timeout/abort/network mapping
// ---------------------------------------------------------------------------

describe('sandboxFetch outcome mapping', () => {
  it('normalizes an Error_Body response forwarding only status + error code', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ status: 404, error: 'NOT_FOUND', message: 'nope', path: '/accounts/x' }, 404),
    );
    const result = await sandboxFetch('/accounts/x', { method: 'GET' }, {}, makeDeps({ fetchImpl }));

    expect(result).toEqual({ kind: 'ERROR', reason: 'HTTP', status: 404, error: 'NOT_FOUND' });
    expect(result).not.toHaveProperty('message');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps a fetch that rejects with an AbortError to ERROR/TIMEOUT', async () => {
    const fetchImpl = vi.fn(async () => {
      throw abortError();
    });
    const result = await sandboxFetch('/customers/me', { method: 'GET' }, {}, makeDeps({ fetchImpl }));
    expect(result).toEqual({ kind: 'ERROR', reason: 'TIMEOUT' });
  });

  it('maps a non-abort fetch throw to ERROR/NETWORK', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const result = await sandboxFetch('/customers/me', { method: 'GET' }, {}, makeDeps({ fetchImpl }));
    expect(result).toEqual({ kind: 'ERROR', reason: 'NETWORK' });
  });

  it('aborts via the AbortController timeout and maps to ERROR/TIMEOUT when fetch never resolves', async () => {
    vi.useFakeTimers();

    // A fetch that only settles (rejecting with an AbortError) once its signal
    // fires — i.e. it never resolves on its own, so only the timeout ends it.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        }
      });
    });

    const promise = sandboxFetch(
      '/customers/me',
      { method: 'GET' },
      { timeoutMs: 10_000 },
      makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    // Drive the timeout deterministically.
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await promise;
    expect(result).toEqual({ kind: 'ERROR', reason: 'TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('respects a custom short timeoutMs supplied via opts', async () => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    });

    const promise = sandboxFetch(
      '/customers/me',
      { method: 'GET' },
      { timeoutMs: 50 },
      makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    await vi.advanceTimersByTimeAsync(50);

    expect(await promise).toEqual({ kind: 'ERROR', reason: 'TIMEOUT' });
  });
});

// ---------------------------------------------------------------------------
// (e) createTransfer — 30s timeout, abort -> TIMEOUT, other throw -> NETWORK
// ---------------------------------------------------------------------------

describe('createTransfer timeout and failure mapping', () => {
  it('returns ERROR/UNEXPECTED without calling fetch when a credential is missing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 201));
    const deps = makeDeps({ getAccessToken: async () => undefined, fetchImpl });

    const result = await createTransfer(TRANSFER_BODY, deps);

    expect(result).toEqual({ kind: 'ERROR', reason: 'UNEXPECTED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a fetch AbortError to ERROR/TIMEOUT', async () => {
    const fetchImpl = vi.fn(async () => {
      throw abortError();
    });
    const result = await createTransfer(TRANSFER_BODY, makeDeps({ fetchImpl }));
    expect(result).toEqual({ kind: 'ERROR', reason: 'TIMEOUT' });
  });

  it('maps a non-abort fetch throw to ERROR/NETWORK', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const result = await createTransfer(TRANSFER_BODY, makeDeps({ fetchImpl }));
    expect(result).toEqual({ kind: 'ERROR', reason: 'NETWORK' });
  });

  it('enforces the 30s transfer timeout, aborting a never-resolving fetch to ERROR/TIMEOUT', async () => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    });

    const promise = createTransfer(
      TRANSFER_BODY,
      makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    // Not yet timed out one tick before the limit.
    await vi.advanceTimersByTimeAsync(TRANSFER_TIMEOUT_MS - 1);
    // Cross the 30s boundary to trigger the abort.
    await vi.advanceTimersByTimeAsync(1);

    const result = await promise;
    expect(result).toEqual({ kind: 'ERROR', reason: 'TIMEOUT' });
    expect(TRANSFER_TIMEOUT_MS).toBe(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps a successful 201 transfer response to COMPLETED', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'TR-1' }, 201));
    const result = await createTransfer(TRANSFER_BODY, makeDeps({ fetchImpl }));
    expect(result).toEqual({ kind: 'COMPLETED', status: 201 });
  });
});
