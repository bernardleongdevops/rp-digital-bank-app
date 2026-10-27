import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  buildHeaders,
  getCustomer,
  listAccounts,
  getAccount,
  getTransactions,
  createTransfer,
  REQUEST_ORIGIN,
  type SandboxConfig,
  type SandboxDeps,
} from '@/lib/server/sandboxClient';
import type { TransferRequest } from '@/lib/types';

/**
 * Property 2: Header injection on every outbound call (task 4.4).
 *
 * For ANY of the typed sandbox calls and ANY generated token / API key, the
 * captured outbound request SHALL carry `Authorization: Bearer <token>` and
 * `X-Sandbox-Key: <key>`, and caller-supplied headers SHALL NOT be able to
 * override or drop those injected credentials. The pure `buildHeaders` helper
 * is also asserted directly: injected credentials always win over `extra`
 * headers, and `Content-Type: application/json` is present exactly when the
 * request carries a body.
 *
 * Validates: Requirements 6.1, 6.4
 */

// A non-empty, header-safe string. Constrained to printable ASCII with no
// leading/trailing whitespace, because the WHATWG `Headers` API normalizes
// (trims surrounding whitespace from) header values on `set`/`get` — so a
// value like "! " would round-trip as "!". Credentials (JWTs, API keys) never
// contain surrounding whitespace, so this is a faithful input space and keeps
// the assertion about VALUE EQUALITY meaningful rather than about `Headers`
// normalization quirks.
const headerValue = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((s) => s.replace(/[^\x21-\x7e]/g, 'x'))
  .filter((s) => s.length > 0);

/** A token / API key: non-empty so the "missing credential" short-circuit never fires. */
const token = headerValue;
const apiKey = headerValue;

/** A benign 200 response so each endpoint fn runs to completion after the fetch. */
function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build injected deps whose `fetchImpl` records the headers it was called with.
 * `sandboxFetch`/`createTransfer` call `fetchImpl(url, { headers, ... })`, so we
 * read the captured init's `headers` (a `Headers` instance).
 */
function makeCapturingDeps(tokenValue: string, apiKeyValue: string) {
  const captured: { url?: string; headers?: Headers }[] = [];
  const config: SandboxConfig = {
    sandboxApiBaseUrl: 'http://localhost:8081/api/v1',
    sandboxApiKey: apiKeyValue,
  };
  const deps: SandboxDeps = {
    getAccessToken: async () => tokenValue,
    getSandboxConfig: () => config,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured.push({ url: String(input), headers });
      return okResponse();
    }) as typeof fetch,
  };
  return { captured, deps };
}

/** Each typed endpoint invoked with injected deps; returns whether a body is sent. */
const endpoints: {
  name: string;
  hasBody: boolean;
  run: (deps: SandboxDeps) => Promise<unknown>;
}[] = [
  { name: 'getCustomer', hasBody: false, run: (d) => getCustomer(d) },
  { name: 'listAccounts', hasBody: false, run: (d) => listAccounts(d) },
  { name: 'getAccount', hasBody: false, run: (d) => getAccount('ACC-1001', d) },
  {
    name: 'getTransactions',
    hasBody: false,
    run: (d) => getTransactions('ACC-1001', undefined, d),
  },
  {
    name: 'createTransfer',
    hasBody: true,
    run: (d) => {
      const body: TransferRequest = {
        fromAccount: 'ACC-1001',
        toAccount: 'ACC-1002',
        amount: 10,
        description: 'test',
      };
      return createTransfer(body, d);
    },
  },
];

describe('Property 2: header injection on every outbound call', () => {
  it('every typed sandbox call carries Authorization and X-Sandbox-Key (Content-Type for bodies)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...endpoints),
        token,
        apiKey,
        async (endpoint, tokenValue, apiKeyValue) => {
          const { captured, deps } = makeCapturingDeps(tokenValue, apiKeyValue);
          await endpoint.run(deps);

          // Exactly one outbound call was issued.
          expect(captured).toHaveLength(1);
          const headers = captured[0].headers!;

          // The two credentials are present and correct on every call.
          expect(headers.get('Authorization')).toBe(`Bearer ${tokenValue}`);
          expect(headers.get('X-Sandbox-Key')).toBe(apiKeyValue);
          // Origin is always pinned.
          expect(headers.get('Origin')).toBe(REQUEST_ORIGIN);
          // Content-Type is present exactly when the request carries a body.
          expect(headers.get('Content-Type')).toBe(
            endpoint.hasBody ? 'application/json' : null,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('buildHeaders injects credentials that caller-supplied extra headers cannot override or drop', () => {
    fc.assert(
      fc.property(
        token,
        apiKey,
        fc.boolean(),
        // A wrong value a malicious/careless caller might try to inject.
        headerValue,
        (tokenValue, apiKeyValue, hasBody, wrongValue) => {
          const extra: Record<string, string> = {
            // Attempts to override the injected credentials with wrong values...
            Authorization: `Bearer ${wrongValue}`,
            'X-Sandbox-Key': wrongValue,
            Origin: 'https://evil.example',
            // ...and an unrelated caller header that SHOULD be preserved.
            'X-Request-Id': wrongValue,
          };

          const headers = buildHeaders({
            token: tokenValue,
            apiKey: apiKeyValue,
            hasBody,
            extra,
          });

          // Injected credentials win regardless of caller attempts.
          expect(headers.get('Authorization')).toBe(`Bearer ${tokenValue}`);
          expect(headers.get('X-Sandbox-Key')).toBe(apiKeyValue);
          expect(headers.get('Origin')).toBe(REQUEST_ORIGIN);

          // Unrelated caller headers are preserved (not dropped).
          expect(headers.get('X-Request-Id')).toBe(wrongValue);

          // Content-Type present iff there is a body.
          expect(headers.get('Content-Type')).toBe(hasBody ? 'application/json' : null);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('buildHeaders injects credentials even with no extra headers', () => {
    fc.assert(
      fc.property(token, apiKey, fc.boolean(), (tokenValue, apiKeyValue, hasBody) => {
        const headers = buildHeaders({ token: tokenValue, apiKey: apiKeyValue, hasBody });
        expect(headers.get('Authorization')).toBe(`Bearer ${tokenValue}`);
        expect(headers.get('X-Sandbox-Key')).toBe(apiKeyValue);
        expect(headers.get('Origin')).toBe(REQUEST_ORIGIN);
        expect(headers.get('Content-Type')).toBe(hasBody ? 'application/json' : null);
      }),
      { numRuns: 200 },
    );
  });
});
