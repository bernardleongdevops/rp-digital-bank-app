// @vitest-environment node
//
// Feature: customer-banking-app, Property 1: Credential confinement
//
// Route-layer analogue of the sandboxClient confinement property (task 4.3).
// There, the secret was confined at the sandbox-client boundary. Here we assert
// the SAME invariant one layer out: for ANY BFF route and ANY upstream outcome,
// the serialized HTTP response the browser receives (status + headers + body)
// contains NEITHER the access token NOR the Sandbox_Key.
//
// Validates: Requirements 6.2, 6.3, 6.7
//
// Strategy
// --------
// The BFF routes build their browser-facing response ONLY from a typed
// `SandboxResult<T>` / `TransferResult` via `respondFromResult` /
// `respondFromTransferResult`, after `requireSession` (which calls
// `getServerSession(getAuthOptions())`) admits the request. So to exercise the
// route layer in isolation we:
//   1. mock `next-auth` so `getServerSession` returns an authenticated session
//      (the credential-less / unauthenticated path is covered by task 4.3 and
//      by the integration tests; here we want the routes to actually run their
//      body-building branches), and
//   2. mock `@/lib/server/sandboxClient` so each function returns a generated
//      range of `SandboxResult` / `TransferResult` values INCLUDING every error
//      variant (HTTP with an arbitrary upstream `error` code, CONFLICT with an
//      arbitrary `error` + `message`, TIMEOUT/NETWORK/UNEXPECTED, RATE_LIMITED,
//      UNAUTHENTICATED), with success `data` shaped like real
//      Customer/Account/Transaction payloads.
//
// We then invoke each route handler, fully serialize the returned `Response`
// (status, every header, and the raw body text) and assert that neither the
// generated token nor the generated API key appears as a substring anywhere.
//
// Threat model (same as task 4.3's component-level property): the Sandbox_Gateway
// is the trusted data source whose legitimate payloads never contain the
// Banking_App's own token/key. We inject the secrets at the credential boundary
// (session + config, via the mocked client's closure) and give the upstream
// results busy, credential-SHAPED decoy values — but never the distinctive
// secret value itself. The only way a distinctive secret could appear in the
// serialized response is a confinement bug in the route/respond layer. The
// transfer route's 409 branch (which forwards `error` + `message`) is included
// explicitly, since that is the one browser-facing branch that forwards an
// upstream-derived string.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

import type {
  Account,
  Customer,
  SandboxResult,
  Transaction,
  TransferResult,
} from '@/lib/types';

const PBT_RUNS = 200;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
//
// `requireSession` (in ./respond) calls `getServerSession(getAuthOptions())`.
// We mock `next-auth` so the session is always present (authenticated) and
// carries ONLY non-secret fields — exactly what the real `session` callback
// exposes. `getAuthOptions` is mocked to a trivial object so no real config is
// touched.

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { name: 'Alice', customerRef: 'CUST-ALICE' },
    expires: '2099-01-01T00:00:00.000Z',
  })),
}));

vi.mock('@/lib/server/auth', () => ({
  getAuthOptions: () => ({}),
}));

// The sandbox client functions are replaced with vi.fn()s whose return values
// are set per-run from the generated outcome.
vi.mock('@/lib/server/sandboxClient', () => ({
  getCustomer: vi.fn(),
  listAccounts: vi.fn(),
  getAccount: vi.fn(),
  getTransactions: vi.fn(),
  createTransfer: vi.fn(),
}));

// Imported AFTER the mocks above so the route modules bind to the mocked deps.
import {
  getCustomer,
  listAccounts,
  getAccount,
  getTransactions,
  createTransfer,
} from '@/lib/server/sandboxClient';

import { GET as customerGET } from '@/app/api/bff/customer/route';
import { GET as accountsGET } from '@/app/api/bff/accounts/route';
import { GET as accountGET } from '@/app/api/bff/accounts/[accountNumber]/route';
import { GET as transactionsGET } from '@/app/api/bff/accounts/[accountNumber]/transactions/route';
import { POST as transfersPOST } from '@/app/api/bff/transfers/route';

const mockGetCustomer = vi.mocked(getCustomer);
const mockListAccounts = vi.mocked(listAccounts);
const mockGetAccount = vi.mocked(getAccount);
const mockGetTransactions = vi.mocked(getTransactions);
const mockCreateTransfer = vi.mocked(createTransfer);

// ---------------------------------------------------------------------------
// Secret generators
// ---------------------------------------------------------------------------
//
// Distinctive, non-empty, non-whitespace secrets. A recognizable prefix makes
// an accidental leak unambiguous in a counterexample; the random suffix keeps
// the search space broad. Whitespace-only/empty values are excluded: they are
// unrealistic credentials and `''.includes()`-style checks are vacuously true,
// which would produce false positives.

const suffixArb: fc.Arbitrary<string> = fc
  .hexaString({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

const tokenArb: fc.Arbitrary<string> = fc.oneof(
  suffixArb.map((s) => `TOKEN_SECRET_${s}`),
  fc.hexaString({ minLength: 8, maxLength: 64 }).map((s) => `TOKEN_SECRET_${s}.jwt`),
  fc.uuid().map((s) => `TOKEN_SECRET_at-${s}`),
);

const apiKeyArb: fc.Arbitrary<string> = fc.oneof(
  suffixArb.map((s) => `KEY_SECRET_${s}`),
  fc.uuid().map((s) => `KEY_SECRET_sk-${s}`),
);

// ---------------------------------------------------------------------------
// Upstream outcome generators (what the mocked sandbox client returns)
// ---------------------------------------------------------------------------
//
// A non-secret, credential-SHAPED decoy. The success/error payloads below carry
// values that LOOK like leaked credentials so that a confinement bug which
// blindly forwarded an upstream field would have an obvious thing to forward —
// but the value is never the distinctive secret a legitimate gateway can't have.
const DECOY = 'DECOY_NOT_A_SECRET';

const customerArb: fc.Arbitrary<Customer> = fc.record({
  customerRef: fc.string(),
  name: fc.string(),
  email: fc.option(fc.string(), { nil: undefined }),
});

const accountArb: fc.Arbitrary<Account> = fc.record({
  accountNumber: fc.string(),
  type: fc.constantFrom('SAVINGS', 'CURRENT'),
  balance: fc.double({ noNaN: true }),
  currency: fc.constantFrom('SGD', 'USD', 'EUR'),
});

const transactionArb: fc.Arbitrary<Transaction> = fc.record({
  id: fc.string(),
  timestamp: fc.constant('2024-01-01T00:00:00.000Z'),
  amount: fc.double({ noNaN: true, min: 0 }),
  direction: fc.constantFrom('CREDIT', 'DEBIT'),
  description: fc.string(),
  counterparty: fc.option(fc.string(), { nil: undefined }),
  runningBalance: fc.option(fc.double({ noNaN: true }), { nil: undefined }),
});

/** Arbitrary upstream `error` code string, incl. credential-shaped decoys. */
const errorCodeArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'INSUFFICIENT_FUNDS',
    'SAME_ACCOUNT',
    'CURRENCY_MISMATCH',
    'INVALID_AMOUNT',
    'ORIGIN_NOT_PERMITTED',
    'FORBIDDEN',
  ),
  fc.string(),
  // A hostile-looking code shaped like a leaked credential (but a decoy).
  fc.constant(`Bearer ${DECOY}`),
);

/** Arbitrary human message, incl. credential-shaped decoys. */
const messageArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.constant(`token=${DECOY}; x-sandbox-key=${DECOY}`),
);

/** Arbitrary HTTP status for the HTTP-error variant. */
const httpStatusArb: fc.Arbitrary<number> = fc.constantFrom(
  400, 402, 403, 404, 405, 409, 422, 500, 502, 503, 504, 999, 0, -1,
);

/**
 * A generated `SandboxResult<T>` covering OK + every failure variant. The OK
 * data is produced by `dataArb`, which varies per read endpoint.
 */
function sandboxResultArb<T>(dataArb: fc.Arbitrary<T>): fc.Arbitrary<SandboxResult<T>> {
  return fc.oneof(
    dataArb.map((data) => ({ kind: 'OK', data }) as SandboxResult<T>),
    fc.constant({ kind: 'UNAUTHENTICATED' } as SandboxResult<T>),
    fc.constant({ kind: 'RATE_LIMITED' } as SandboxResult<T>),
    fc.record({
      kind: fc.constant('ERROR' as const),
      reason: fc.constant('HTTP' as const),
      status: httpStatusArb,
      error: fc.option(errorCodeArb, { nil: undefined }),
    }) as fc.Arbitrary<SandboxResult<T>>,
    fc
      .constantFrom('TIMEOUT', 'NETWORK', 'UNEXPECTED')
      .map((reason) => ({ kind: 'ERROR', reason }) as SandboxResult<T>),
  );
}

/** A generated `TransferResult` covering success + every failure variant. */
const transferResultArb: fc.Arbitrary<TransferResult> = fc.oneof(
  fc.constant({ kind: 'COMPLETED', status: 201 } as TransferResult),
  fc.constant({ kind: 'AML_HELD', status: 202 } as TransferResult),
  fc.constant({ kind: 'AML_BLOCKED', status: 422 } as TransferResult),
  // The one browser-facing branch that forwards upstream-derived strings.
  fc.record({
    kind: fc.constant('CONFLICT' as const),
    status: fc.constant(409 as const),
    error: errorCodeArb,
    message: messageArb,
  }) as fc.Arbitrary<TransferResult>,
  fc.constant({ kind: 'FORBIDDEN', status: 403 } as TransferResult),
  fc.constant({ kind: 'UNAUTHENTICATED', status: 401 } as TransferResult),
  fc.constant({ kind: 'RATE_LIMITED', status: 429 } as TransferResult),
  fc
    .constantFrom('TIMEOUT', 'NETWORK', 'UNEXPECTED')
    .map((reason) => ({ kind: 'ERROR', reason }) as TransferResult),
);

const transferBodyArb = fc.record({
  fromAccount: fc.constant('ACC-1001'),
  toAccount: fc.constant('ACC-1002'),
  amount: fc.double({ min: 0.01, max: 999_999_999.99, noNaN: true }),
  description: fc.string({ maxLength: 140 }),
});

// ---------------------------------------------------------------------------
// Serialization + assertion helpers
// ---------------------------------------------------------------------------

/**
 * Fully serialize a `Response` to the bytes/metadata a browser would receive:
 * the status, every header (name + value), and the raw body text. Returned as a
 * single string so a substring search covers headers AND body in one pass.
 */
async function serializeResponse(res: Response): Promise<string> {
  const parts: string[] = [`status:${res.status}`];
  res.headers.forEach((value, key) => {
    parts.push(`header:${key}=${value}`);
  });
  const body = await res.clone().text();
  parts.push(`body:${body}`);
  return parts.join('\n');
}

/** Assert neither secret appears anywhere in the serialized response. */
async function assertResponseHasNoSecret(
  res: Response,
  token: string,
  apiKey: string,
): Promise<void> {
  const serialized = await serializeResponse(res);

  expect(
    serialized.includes(token),
    `token leaked into BFF response: ${serialized}`,
  ).toBe(false);
  expect(
    serialized.includes(apiKey),
    `apiKey leaked into BFF response: ${serialized}`,
  ).toBe(false);

  // Extra belt-and-braces header sweep (the spec calls for iterating headers
  // explicitly): no header name or value may contain either secret.
  res.headers.forEach((value, key) => {
    expect(value.includes(token)).toBe(false);
    expect(value.includes(apiKey)).toBe(false);
    expect(key.includes(token)).toBe(false);
    expect(key.includes(apiKey)).toBe(false);
  });
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 1: Credential confinement across BFF routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/bff/customer never leaks the token or API key', async () => {
    await fc.assert(
      fc.asyncProperty(
        tokenArb,
        apiKeyArb,
        sandboxResultArb(customerArb),
        async (token, apiKey, result) => {
          mockGetCustomer.mockResolvedValueOnce(result);
          const res = await customerGET();
          await assertResponseHasNoSecret(res, token, apiKey);
        },
      ),
      { numRuns: PBT_RUNS },
    );
  });

  it('GET /api/bff/accounts never leaks the token or API key', async () => {
    await fc.assert(
      fc.asyncProperty(
        tokenArb,
        apiKeyArb,
        sandboxResultArb(fc.array(accountArb, { maxLength: 6 })),
        async (token, apiKey, result) => {
          mockListAccounts.mockResolvedValueOnce(result);
          const res = await accountsGET();
          await assertResponseHasNoSecret(res, token, apiKey);
        },
      ),
      { numRuns: PBT_RUNS },
    );
  });

  it('GET /api/bff/accounts/[accountNumber] never leaks the token or API key', async () => {
    await fc.assert(
      fc.asyncProperty(
        tokenArb,
        apiKeyArb,
        sandboxResultArb(accountArb),
        fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
        async (token, apiKey, result, accountNumber) => {
          mockGetAccount.mockResolvedValueOnce(result);
          const req = new Request('http://localhost:3000/api/bff/accounts/x');
          const res = await accountGET(req, { params: { accountNumber } });
          await assertResponseHasNoSecret(res, token, apiKey);
        },
      ),
      { numRuns: PBT_RUNS },
    );
  });

  it('GET /api/bff/accounts/[accountNumber]/transactions never leaks the token or API key', async () => {
    await fc.assert(
      fc.asyncProperty(
        tokenArb,
        apiKeyArb,
        sandboxResultArb(fc.array(transactionArb, { maxLength: 6 })),
        fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
        async (token, apiKey, result, accountNumber) => {
          mockGetTransactions.mockResolvedValueOnce(result);
          const req = new Request(
            'http://localhost:3000/api/bff/accounts/x/transactions?from=2024-01-01&to=2024-12-31',
          );
          const res = await transactionsGET(req, { params: { accountNumber } });
          await assertResponseHasNoSecret(res, token, apiKey);
        },
      ),
      { numRuns: PBT_RUNS },
    );
  });

  it('POST /api/bff/transfers never leaks the token or API key (incl. 409 forwarding error+message)', async () => {
    await fc.assert(
      fc.asyncProperty(
        tokenArb,
        apiKeyArb,
        transferResultArb,
        transferBodyArb,
        async (token, apiKey, result, body) => {
          mockCreateTransfer.mockResolvedValueOnce(result);
          const req = new Request('http://localhost:3000/api/bff/transfers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const res = await transfersPOST(req);
          await assertResponseHasNoSecret(res, token, apiKey);
        },
      ),
      { numRuns: PBT_RUNS },
    );
  });
});
