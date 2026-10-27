import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  sandboxFetch,
  getCustomer,
  listAccounts,
  getAccount,
  getTransactions,
  createTransfer,
  type SandboxConfig,
  type SandboxDeps,
} from '@/lib/server/sandboxClient';
import type { TransferRequest } from '@/lib/types';

/**
 * Feature: customer-banking-app, Property 1: Credential confinement
 *
 * For any upstream sandbox outcome (success, any error status, a normalized
 * `Error_Body`, a body that echoes the request headers, a network throw, or an
 * abort/timeout), the value returned by `sandboxClient` to its caller SHALL NOT
 * contain the access token value or the Sandbox_Key value anywhere in its
 * serialized form; and when either credential is absent server-side, the client
 * SHALL return an unauthenticated result WITHOUT issuing the outbound request.
 *
 * Validates: Requirements 6.2, 6.3, 6.5, 6.6, 6.7
 *
 * Strategy: the token provider, config provider and `fetch` are injected via
 * `SandboxDeps`. fast-check generates arbitrary *distinctive* secrets (a known
 * prefix plus random, non-whitespace suffix) and arbitrary upstream responses,
 * then serializes the ENTIRE returned result and asserts neither secret appears
 * as a substring.
 *
 * Threat model / scope (per design "BFF normalization and secret confinement"):
 * the Sandbox_Gateway is the trusted data source — its legitimate bodies
 * (Customer/Account/Transaction/Error_Body) never contain the Banking_App's own
 * access token or Sandbox_Key. The property we assert is that the client never
 * *injects* those credentials into the value it returns (success data, error
 * code, message, or any synthesized field). We therefore model realistic and
 * even hostile-looking upstream payloads, but a distinctive secret value that a
 * legitimate upstream would never carry; the only way it could appear in the
 * returned value is a confinement bug in the client. (A compromised upstream
 * deliberately crafting a body equal to the secret is a different threat that
 * this component-level property does not model.)
 */

const PBT_RUNS = 200;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Distinctive, non-empty, non-whitespace secret values. A recognizable prefix
 * makes an accidental leak unambiguous to spot in a counterexample; the random
 * alphanumeric suffix keeps the search space broad. Secrets are guaranteed not
 * to be whitespace-only (which would both be an unrealistic credential and
 * break header round-tripping, since `Headers` trims surrounding whitespace).
 */
const suffixArb: fc.Arbitrary<string> = fc
  .hexaString({ minLength: 1, maxLength: 40 })
  .filter((s) => s.length > 0);

const tokenArb: fc.Arbitrary<string> = fc.oneof(
  suffixArb.map((s) => `TOK_SECRET_${s}`),
  fc.hexaString({ minLength: 8, maxLength: 64 }).map((s) => `tok.${s}.jwt`),
  fc.uuid().map((s) => `at-${s}`),
);

const apiKeyArb: fc.Arbitrary<string> = fc.oneof(
  suffixArb.map((s) => `KEY_SECRET_${s}`),
  fc.uuid().map((s) => `sk-${s}`),
);

const baseUrlArb: fc.Arbitrary<string> = fc.constantFrom(
  'http://localhost:8081/api/v1',
  'https://sandbox.example.test/api/v1',
);

/** Statuses spanning OK, auth, rate-limit, CORS/origin, conflict, and misc. */
const statusArb: fc.Arbitrary<number> = fc.constantFrom(
  200, 201, 202, 204, 400, 401, 403, 409, 422, 429, 500, 502, 503,
);

/**
 * An arbitrary upstream response outcome. The `noisy-*` flavors return busy,
 * hostile-looking payloads (deeply nested JSON, extra headers, a reflected
 * request-shaped field) to maximize the chance a confinement bug would surface
 * the real secret — but they never contain the distinctive secret value a
 * legitimate gateway would never carry. `throw`/`abort` exercise the catch
 * path (NETWORK / TIMEOUT mapping).
 */
type Outcome =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'text'; status: number; text: string }
  | { kind: 'noisy-body'; status: number }
  | { kind: 'noisy-headers'; status: number }
  | { kind: 'errorBody'; status: number; error: string; message: string }
  | { kind: 'throw' }
  | { kind: 'abort' };

/**
 * The distinctive prefixes the secret generators use (see `tokenArb`/`apiKeyArb`
 * above). The fake gateway's generated bodies must never coincidentally contain
 * these, otherwise `assertNoLeak`'s substring check would flag the gateway's OWN
 * (trusted) data as if the APP had leaked a credential. Per this test's threat
 * model the gateway never carries the app's token/key, so we exclude the
 * prefixes from the free-string body generators to keep the property
 * deterministic across all seeds.
 */
const SECRET_PREFIXES = ['TOK_SECRET_', 'KEY_SECRET_', 'tok.', 'at-', 'sk-'];

/** A free string that can never collide with a generated secret value. */
const nonSecretString = (opts?: { maxLength?: number }) =>
  fc.string(opts).filter((s) => !SECRET_PREFIXES.some((p) => s.includes(p)));

/** An arbitrary JSON value with no embedded secret-prefixed strings. */
const nonSecretJson = fc
  .jsonValue()
  .filter((v) => !SECRET_PREFIXES.some((p) => JSON.stringify(v).includes(p)));

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  fc.record({
    kind: fc.constant('json' as const),
    status: statusArb,
    body: fc.oneof(
      nonSecretJson,
      fc.record({
        accountNumber: nonSecretString(),
        balance: fc.double(),
        currency: nonSecretString(),
      }),
      fc.array(fc.record({ id: nonSecretString(), amount: fc.double() })),
    ),
  }),
  fc.record({
    kind: fc.constant('text' as const),
    status: statusArb,
    text: nonSecretString(),
  }),
  fc.record({ kind: fc.constant('noisy-body' as const), status: statusArb }),
  fc.record({ kind: fc.constant('noisy-headers' as const), status: statusArb }),
  fc.record({
    kind: fc.constant('errorBody' as const),
    status: fc.constantFrom(400, 403, 409, 422, 500),
    error: fc.oneof(
      fc.constantFrom('INSUFFICIENT_FUNDS', 'SAME_ACCOUNT', 'CORS_ORIGIN_DENIED', 'FORBIDDEN'),
      nonSecretString(),
    ),
    message: nonSecretString(),
  }),
  fc.record({ kind: fc.constant('throw' as const) }),
  fc.record({ kind: fc.constant('abort' as const) }),
);

const transferBodyArb: fc.Arbitrary<TransferRequest> = fc.record({
  fromAccount: nonSecretString(),
  toAccount: nonSecretString(),
  amount: fc.double({ min: 0.01, max: 999_999_999.99, noNaN: true }),
  description: nonSecretString({ maxLength: 140 }),
});

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** A non-secret decoy marker used by the noisy outcomes. */
const DECOY = 'DECOY_NOT_A_SECRET';

/**
 * Build a fake `fetchImpl` realizing `outcome`. It records the outbound call so
 * the test can lightly confirm the credentials actually travelled on the wire
 * (Property 2's focus — kept light here). An `abort` outcome rejects with an
 * `AbortError` DOMException so the client maps it to TIMEOUT. The noisy flavors
 * return busy bodies/headers shaped like credential material but using a decoy
 * value, never the distinctive secret a legitimate gateway would never carry.
 */
function makeFetch(outcome: Outcome, captured: Captured[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init });

    switch (outcome.kind) {
      case 'throw':
        throw new TypeError('network down');
      case 'abort':
        throw new DOMException('The operation was aborted.', 'AbortError');
      case 'json':
        return new Response(JSON.stringify(outcome.body), {
          status: outcome.status,
          headers: { 'Content-Type': 'application/json' },
        });
      case 'text':
        return new Response(outcome.text, { status: outcome.status });
      case 'errorBody':
        return new Response(
          JSON.stringify({
            timestamp: new Date(0).toISOString(),
            status: outcome.status,
            error: outcome.error,
            message: outcome.message,
            path: '/x',
          }),
          { status: outcome.status, headers: { 'Content-Type': 'application/json' } },
        );
      case 'noisy-body':
        // Busy, credential-shaped body — but with a decoy value, not the secret.
        return new Response(
          JSON.stringify({
            seenAuthorization: `Bearer ${DECOY}`,
            seenSandboxKey: DECOY,
            nested: { headers: { authorization: `Bearer ${DECOY}`, 'x-sandbox-key': DECOY } },
            note: `token=${DECOY} key=${DECOY}`,
          }),
          { status: outcome.status, headers: { 'Content-Type': 'application/json' } },
        );
      case 'noisy-headers':
        // Extra response headers shaped like credential echoes, with a decoy.
        return new Response(JSON.stringify({ ok: true }), {
          status: outcome.status,
          headers: {
            'Content-Type': 'application/json',
            'X-Echoed-Authorization': `Bearer ${DECOY}`,
            'X-Echoed-Key': DECOY,
          },
        });
    }
  }) as typeof fetch;
}

function makeDeps(
  outcome: Outcome,
  token: string | undefined,
  apiKey: string,
  baseUrl: string,
  captured: Captured[],
): SandboxDeps {
  const config: SandboxConfig = { sandboxApiBaseUrl: baseUrl, sandboxApiKey: apiKey };
  return {
    getAccessToken: async () => token,
    getSandboxConfig: () => config,
    fetchImpl: makeFetch(outcome, captured),
  };
}

/**
 * Assert neither secret appears in the serialized returned value. An empty
 * secret is skipped: it is not a value to confine, and `includes('')` is
 * vacuously true for every string. (The missing-credential case deliberately
 * exercises an absent token / empty API key.)
 */
function assertNoLeak(result: unknown, token: string, apiKey: string): void {
  const serialized = JSON.stringify(result) ?? '';
  if (token.length > 0) {
    expect(serialized.includes(token), `token leaked into result: ${serialized}`).toBe(false);
  }
  if (apiKey.length > 0) {
    expect(serialized.includes(apiKey), `apiKey leaked into result: ${serialized}`).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 1: Credential confinement (sandboxClient)', () => {
  it('sandboxFetch never leaks the token or API key into the returned result', async () => {
    await fc.assert(
      fc.asyncProperty(
        tokenArb,
        apiKeyArb,
        baseUrlArb,
        outcomeArb,
        fc.string({ maxLength: 20 }).map((s) => `/${s}`),
        fc.boolean(),
        async (token, apiKey, baseUrl, outcome, path, withBody) => {
          const captured: Captured[] = [];
          const deps = makeDeps(outcome, token, apiKey, baseUrl, captured);
          const init: RequestInit = withBody
            ? { method: 'POST', body: JSON.stringify({ x: 1 }) }
            : { method: 'GET' };

          const result = await sandboxFetch(path, init, { timeoutMs: 50 }, deps);

          assertNoLeak(result, token, apiKey);

          // Light Property-2 confirmation: when a request was issued, the
          // credentials DID travel on the outbound headers.
          if (captured.length > 0) {
            const headers = new Headers(captured[0].init?.headers);
            expect(headers.get('Authorization')).toBe(`Bearer ${token}`);
            expect(headers.get('X-Sandbox-Key')).toBe(apiKey);
          }
        },
      ),
      { numRuns: PBT_RUNS },
    );
  });

  it('typed read wrappers never leak the token or API key', async () => {
    await fc.assert(
      fc.asyncProperty(
        tokenArb,
        apiKeyArb,
        baseUrlArb,
        outcomeArb,
        fc.string({ maxLength: 16 }),
        async (token, apiKey, baseUrl, outcome, accountNumber) => {
          const captured: Captured[] = [];
          const deps = makeDeps(outcome, token, apiKey, baseUrl, captured);

          const results = await Promise.all([
            getCustomer(deps),
            listAccounts(deps),
            getAccount(accountNumber, deps),
            getTransactions(accountNumber, { from: '2024-01-01', to: '2024-12-31' }, deps),
          ]);

          for (const result of results) {
            assertNoLeak(result, token, apiKey);
          }
        },
      ),
      { numRuns: PBT_RUNS },
    );
  });

  it('createTransfer never leaks the token or API key into the TransferResult', async () => {
    await fc.assert(
      fc.asyncProperty(
        tokenArb,
        apiKeyArb,
        baseUrlArb,
        outcomeArb,
        transferBodyArb,
        async (token, apiKey, baseUrl, outcome, body) => {
          const captured: Captured[] = [];
          const deps = makeDeps(outcome, token, apiKey, baseUrl, captured);

          const result = await createTransfer(body, deps);

          assertNoLeak(result, token, apiKey);

          if (captured.length > 0) {
            const headers = new Headers(captured[0].init?.headers);
            expect(headers.get('Authorization')).toBe(`Bearer ${token}`);
            expect(headers.get('X-Sandbox-Key')).toBe(apiKey);
            expect(headers.get('Content-Type')).toBe('application/json');
          }
        },
      ),
      { numRuns: PBT_RUNS },
    );
  });

  it('missing credentials yield an unauthenticated result with NO outbound request', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Either the token is absent, or the API key is empty, or both.
        fc.oneof(tokenArb, fc.constant(undefined)),
        fc.oneof(apiKeyArb, fc.constant('')),
        baseUrlArb,
        transferBodyArb,
        async (token, apiKey, baseUrl, body) => {
          // Only exercise the missing-credential space.
          fc.pre(!token || apiKey === '');

          const captured: Captured[] = [];
          // Outcome is irrelevant: fetch must never be called.
          const deps = makeDeps({ kind: 'throw' }, token, apiKey, baseUrl, captured);

          const readResult = await sandboxFetch('/customers/me', { method: 'GET' }, {}, deps);
          const transferResult = await createTransfer(body, deps);

          // No outbound request was issued (Requirement 6.5).
          expect(captured.length).toBe(0);

          // The read path returns UNAUTHENTICATED; the transfer path returns an
          // ERROR with no status (no HTTP exchange happened).
          expect(readResult.kind).toBe('UNAUTHENTICATED');
          expect(transferResult.kind).toBe('ERROR');

          // And of course nothing secret is present.
          assertNoLeak(readResult, token ?? '', apiKey);
          assertNoLeak(transferResult, token ?? '', apiKey);
        },
      ),
      { numRuns: PBT_RUNS },
    );
  });
});
