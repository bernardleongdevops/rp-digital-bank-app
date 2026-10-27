// @vitest-environment node
//
// Feature: customer-banking-app
// Validates: Requirements 11.1, 11.2, 11.3, 11.4 ; Properties P1-P7
//
// Task 13.2 — End-to-end mocked-sandbox verification (property-coverage half).
//
// This suite is the wired-level "property coverage" index for the application.
// It does NOT re-run the full property suites (those already pass in depth —
// see the per-property references on each `describe` below). Instead it
// EXPLICITLY asserts each invariant P1-P7 once at the wired level by invoking
// the SAME shared pure / boundary functions the application uses, with
// representative inputs, so a reviewer can confirm in one place that every
// property holds across the assembled system — and that no assertion here
// performs a live network request (Requirement 11.1): every sandbox boundary is
// either a pure function call or goes through an injected / mocked dependency.
//
// The RTL view half (loading / empty / error states for each
// Sandbox_Gateway-dependent view, with the browser `fetch` mocked) lives in
// `app/e2e/wiredViews.e2e.test.tsx`; it must run under jsdom, which is why the
// property-coverage assertions that need the `node` environment are split here.
//
// Depth references (each property's dedicated, in-depth test file):
//   P1 Credential confinement .. lib/server/sandboxClient.confinement.test.ts
//                                app/api/bff/_lib/routes.confinement.property.test.ts
//   P2 Header injection ........ lib/server/sandboxClient.headers.property.test.ts
//   P3 Outcome determinism ..... lib/transferPresentation.test.ts
//   P4 Validation soundness .... lib/transferValidation.test.ts
//   P5 No direct gateway calls . app/__guards__/no-direct-gateway-calls.test.ts
//   P6 Config integrity ........ lib/server/config.test.ts
//   P7 Idempotent submit guard . lib/transferSubmit.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import { buildHeaders, createTransfer } from '@/lib/server/sandboxClient';
import { mapTransferOutcome } from '@/lib/transferPresentation';
import { validateTransferForm, type TransferFormValues } from '@/lib/transferValidation';
import { SubmitGuard } from '@/lib/transferSubmit';
import { validateEnv, ENV_VARS, type EnvLike } from '@/lib/server/config';
import type { TransferResult } from '@/lib/types';

// A distinctive secret used to prove confinement. A legitimate sandbox payload
// never contains this value, so its presence anywhere browser-facing is a bug.
const TOKEN = 'TOKEN_SECRET_wired_e2e_abc123';
const API_KEY = 'KEY_SECRET_wired_e2e_def456';

// ---------------------------------------------------------------------------
// P1 — Credential confinement (Requirements 6.2, 6.3, 6.5, 6.6, 6.7)
// ---------------------------------------------------------------------------
//
// Wired-level sampling: drive `createTransfer` (the sandbox boundary) through a
// MOCKED fetch returning a representative spread of upstream outcomes, and
// assert the returned `TransferResult` never carries the token or API key in
// any field — the same confinement guaranteed in depth by
// lib/server/sandboxClient.confinement.test.ts. No live network: fetch is
// injected. Also re-assert the BFF `respond` helper never widens the surface.

describe('P1 credential confinement (wired sampling)', () => {
  const sandboxConfig = { sandboxApiBaseUrl: 'http://sandbox.local/api/v1', sandboxApiKey: API_KEY };

  /** All the string values of an object graph, flattened for a secret sweep. */
  function flatten(value: unknown, acc: string[] = []): string[] {
    if (value === null || value === undefined) return acc;
    if (typeof value === 'string') {
      acc.push(value);
    } else if (typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) flatten(v, acc);
    } else {
      acc.push(String(value));
    }
    return acc;
  }

  it('never surfaces the token or API key for any upstream transfer status', async () => {
    const statuses = [201, 202, 409, 403, 401, 422, 429, 500, 418];
    for (const status of statuses) {
      // A mocked upstream response whose body even CONTAINS the secrets, to
      // prove the boundary strips them rather than forwarding blindly.
      const fetchImpl = (async () =>
        new Response(
          JSON.stringify({
            error: 'INSUFFICIENT_FUNDS',
            message: 'ok',
            leaked_token: TOKEN,
            leaked_key: API_KEY,
          }),
          { status, headers: { 'Content-Type': 'application/json' } },
        )) as unknown as typeof fetch;

      const result: TransferResult = await createTransfer(
        { fromAccount: 'ACC-1001', toAccount: 'ACC-1002', amount: 100, description: 'd' },
        {
          getAccessToken: async () => TOKEN,
          getSandboxConfig: () => sandboxConfig,
          fetchImpl,
        },
      );

      const strings = flatten(result);
      for (const s of strings) {
        expect(s.includes(TOKEN), `token leaked for status ${status}`).toBe(false);
        expect(s.includes(API_KEY), `apiKey leaked for status ${status}`).toBe(false);
      }
    }
  });

  it('returns UNAUTHENTICATED without issuing a request when a credential is missing (6.5)', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await createTransfer(
      { fromAccount: 'ACC-1001', toAccount: 'ACC-1002', amount: 100, description: 'd' },
      {
        getAccessToken: async () => undefined, // no token
        getSandboxConfig: () => sandboxConfig,
        fetchImpl,
      },
    );

    // No outbound request was issued.
    expect(called).toBe(false);
    // The credential-less transfer surfaces as a non-leaking error outcome.
    expect(result.kind).toBe('ERROR');
    expect(JSON.stringify(result).includes(TOKEN)).toBe(false);
    expect(JSON.stringify(result).includes(API_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P2 — Header injection on every outbound call (Requirements 6.1, 6.4)
// ---------------------------------------------------------------------------
//
// `buildHeaders` is the single place credentials are attached; every sandbox
// call routes through it. Assert it injects Authorization + X-Sandbox-Key for
// any call, and Content-Type for calls with a body. In-depth coverage:
// lib/server/sandboxClient.headers.property.test.ts.

describe('P2 header injection (wired invariant)', () => {
  it('injects Authorization + X-Sandbox-Key on a bodyless read', () => {
    const headers = buildHeaders({ token: TOKEN, apiKey: API_KEY, hasBody: false });
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('X-Sandbox-Key')).toBe(API_KEY);
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('additionally injects Content-Type: application/json for a body-bearing call', () => {
    const headers = buildHeaders({ token: TOKEN, apiKey: API_KEY, hasBody: true });
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('X-Sandbox-Key')).toBe(API_KEY);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('cannot have the injected credentials overridden by caller headers', () => {
    const headers = buildHeaders({
      token: TOKEN,
      apiKey: API_KEY,
      hasBody: true,
      extra: { Authorization: 'Bearer HIJACK', 'X-Sandbox-Key': 'HIJACK' },
    });
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('X-Sandbox-Key')).toBe(API_KEY);
  });
});

// ---------------------------------------------------------------------------
// P3 — Transfer outcome determinism / totality (Requirements 4.3-4.10)
// ---------------------------------------------------------------------------
//
// `mapTransferOutcome` is total and deterministic over any status. Assert the
// covered statuses map to their distinct kinds and that odd / uncovered
// statuses all fall through to a generic retryable error. In-depth coverage:
// lib/transferPresentation.test.ts.

describe('P3 transfer outcome determinism (wired invariant)', () => {
  it('maps each covered status to its distinct outcome kind', () => {
    expect(mapTransferOutcome({ status: 201 }).kind).toBe('COMPLETED');
    expect(mapTransferOutcome({ status: 202 }).kind).toBe('AML_HELD');
    expect(mapTransferOutcome({ status: 422 }).kind).toBe('AML_BLOCKED');
    expect(mapTransferOutcome({ status: 409, error: 'INSUFFICIENT_FUNDS' }).kind).toBe('CONFLICT');
    expect(mapTransferOutcome({ status: 403 }).kind).toBe('FORBIDDEN');
    expect(mapTransferOutcome({ status: 401 }).requiresReauth).toBe(true);
    expect(mapTransferOutcome({ status: 429 }).isRateLimit).toBe(true);
  });

  it('is total: every representative + odd status yields exactly one presentation', () => {
    for (const status of [200, 204, 300, 418, 500, 502, 504, 999, 0, -1]) {
      const p = mapTransferOutcome({ status });
      expect(typeof p.kind).toBe('string');
      expect(typeof p.title).toBe('string');
      expect(typeof p.message).toBe('string');
    }
    // Determinism: identical input -> identical output.
    expect(mapTransferOutcome({ status: 409, error: 'SAME_ACCOUNT' })).toEqual(
      mapTransferOutcome({ status: 409, error: 'SAME_ACCOUNT' }),
    );
  });
});

// ---------------------------------------------------------------------------
// P4 — Validation soundness (Requirements 3.3, 3.4, 5.1-5.6)
// ---------------------------------------------------------------------------
//
// `validateTransferForm` accepts a fully valid input and rejects each
// representative violation. In-depth coverage: lib/transferValidation.test.ts.

describe('P4 validation soundness (wired invariant)', () => {
  const VALID: TransferFormValues = {
    fromAccount: 'ACC-1001',
    toAccount: 'ACC-1002',
    amount: '100.00',
    description: 'rent',
  };

  it('accepts a fully valid input (no errors)', () => {
    expect(validateTransferForm(VALID)).toEqual({});
  });

  it('rejects each representative invalid input with a field-level error', () => {
    expect(validateTransferForm({ ...VALID, fromAccount: '' }).fromAccount).toBeDefined();
    expect(validateTransferForm({ ...VALID, toAccount: '' }).toAccount).toBeDefined();
    expect(validateTransferForm({ ...VALID, toAccount: 'ACC-1001' }).toAccount).toBeDefined();
    expect(validateTransferForm({ ...VALID, amount: '0' }).amount).toBeDefined();
    expect(validateTransferForm({ ...VALID, amount: '1.005' }).amount).toBeDefined();
    expect(validateTransferForm({ ...VALID, amount: 'abc' }).amount).toBeDefined();
    expect(
      validateTransferForm({ ...VALID, description: 'x'.repeat(141) }).description,
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// P5 — No direct browser-to-gateway calls (Requirements 6.4, 10.5)
// ---------------------------------------------------------------------------
//
// The authoritative, in-depth guarantee is the static source scan in
// app/__guards__/no-direct-gateway-calls.test.ts (which enumerates every
// client-reachable file and asserts every fetch target is /api/bff/*). The
// runtime complement — every request the wired VIEWS make is same-origin
// /api/bff/* — is asserted in app/e2e/wiredViews.e2e.test.tsx via
// `assertAllBffOnly`. Here we add a lightweight wired re-assertion that the
// shared transfer-submit endpoint constant is the same-origin BFF path, so the
// property is represented in this coverage index too.

describe('P5 no direct browser-to-gateway calls (wired reference)', () => {
  it('the transfer submit endpoint constant is the same-origin BFF path', async () => {
    const { TRANSFER_ENDPOINT } = await import('@/lib/transferSubmit');
    expect(TRANSFER_ENDPOINT).toBe('/api/bff/transfers');
    expect(TRANSFER_ENDPOINT.startsWith('/api/bff/')).toBe(true);
    expect(/^https?:\/\//i.test(TRANSFER_ENDPOINT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P6 — Config integrity / fail-fast (Requirements 7.6, 7.7)
// ---------------------------------------------------------------------------
//
// `validateEnv` flags a missing required var and a malformed URL by name, and
// accepts a valid env. In-depth coverage: lib/server/config.test.ts.

describe('P6 config integrity (wired invariant)', () => {
  /** A fully valid env (every required var present, URLs well-formed). */
  const VALID_ENV: EnvLike = {
    NEXTAUTH_URL: 'http://localhost:3000',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    NEXTAUTH_SECRET: 'a-very-secret-value',
    KEYCLOAK_ISSUER: 'http://localhost:8080/realms/digital-bank',
    KEYCLOAK_CLIENT_ID: 'sandbox-web',
    SANDBOX_API_BASE_URL: 'http://localhost:8081/api/v1',
    SANDBOX_API_KEY: 'demo-key-123',
  };

  it('accepts a valid env (no errors)', () => {
    expect(validateEnv(VALID_ENV)).toEqual([]);
  });

  it('flags a missing required var by name', () => {
    const env = { ...VALID_ENV, [ENV_VARS.nextAuthSecret]: '' };
    const errors = validateEnv(env);
    const offenders = errors.map((e) => e.variable);
    expect(offenders).toContain(ENV_VARS.nextAuthSecret);
    expect(errors.find((e) => e.variable === ENV_VARS.nextAuthSecret)?.kind).toBe('missing');
  });

  it('flags a malformed URL by name', () => {
    const env = { ...VALID_ENV, [ENV_VARS.sandboxApiBaseUrl]: 'not a url' };
    const errors = validateEnv(env);
    expect(errors.find((e) => e.variable === ENV_VARS.sandboxApiBaseUrl)?.kind).toBe(
      'malformed-url',
    );
  });
});

// ---------------------------------------------------------------------------
// P7 — Idempotent submit guard (Requirement 4.2)
// ---------------------------------------------------------------------------
//
// `SubmitGuard.begin()` grants exactly once while a request is in flight and
// grants again only after `end()`. In-depth coverage: lib/transferSubmit.test.ts.

describe('P7 idempotent submit guard (wired invariant)', () => {
  it('grants once while in flight, then again after end()', () => {
    const guard = new SubmitGuard();
    expect(guard.begin()).toBe(true); // first submit admitted
    expect(guard.begin()).toBe(false); // repeat while in flight rejected
    expect(guard.begin()).toBe(false);
    guard.end();
    expect(guard.begin()).toBe(true); // next cycle admitted
  });

  it('for any sequence of submits while in flight, admits at most one per cycle', () => {
    fc.assert(
      fc.property(fc.array(fc.constant('submit'), { minLength: 1, maxLength: 20 }), (submits) => {
        const guard = new SubmitGuard();
        let granted = 0;
        for (let i = 0; i < submits.length; i += 1) {
          if (guard.begin()) granted += 1;
        }
        // Only the first submit of the (single, never-ended) cycle is admitted.
        return granted === 1;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Consolidated: no browser-facing BFF response exposes a secret (Req 11.1 /
// P1 at the route layer, re-asserted end-to-end with the sandbox mocked).
// ---------------------------------------------------------------------------
//
// Invoke a BFF route with a mocked session + mocked sandbox client (as in
// bffRoutes.integration.test.ts) and prove the serialized browser-facing
// response contains neither the access token nor the Sandbox_Key. This ties
// the confinement property to an actual wired route rather than only the
// boundary function above.

// The auth boundary is mocked so the route admits an authenticated session
// without a real OIDC flow. The sandbox client is NOT module-mocked here (the
// P1/P2 sections depend on the real `createTransfer`/`buildHeaders`); instead
// the consolidated test spies on `createTransfer` at call time.
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/server/auth', () => ({ getAuthOptions: vi.fn(() => ({})) }));

describe('Consolidated: BFF route never exposes a secret (wired, sandbox mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a wired BFF transfer response carries no token or API key', async () => {
    const { getServerSession } = await import('next-auth');
    const sandbox = await import('@/lib/server/sandboxClient');
    const { POST: transfersPOST } = await import('@/app/api/bff/transfers/route');

    // Authenticated session that carries ONLY non-secret fields.
    vi.mocked(getServerSession).mockResolvedValue({
      user: { name: 'Alice', customerRef: 'CUST-ALICE' },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);

    // Spy on the sandbox transfer so no real outbound call is made and the
    // route sees a controlled 409 CONFLICT — the one browser-facing branch that
    // forwards an upstream error code + message.
    vi.spyOn(sandbox, 'createTransfer').mockResolvedValue({
      kind: 'CONFLICT',
      status: 409,
      error: 'INSUFFICIENT_FUNDS',
      message: 'Not enough balance',
    });

    const req = new Request('http://localhost:3000/api/bff/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromAccount: 'ACC-1001',
        toAccount: 'ACC-1002',
        amount: 100,
        description: 'rent',
      }),
    });

    const res = await transfersPOST(req);

    const bodyText = await res.clone().text();
    expect(bodyText.includes(TOKEN)).toBe(false);
    expect(bodyText.includes(API_KEY)).toBe(false);
    res.headers.forEach((value, key) => {
      expect(value.includes(TOKEN)).toBe(false);
      expect(value.includes(API_KEY)).toBe(false);
      expect(key.includes(TOKEN)).toBe(false);
      expect(key.includes(API_KEY)).toBe(false);
    });
    // The non-secret conflict code + message are present (status mirrored).
    expect(res.status).toBe(409);
  });
});
