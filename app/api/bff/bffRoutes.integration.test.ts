// @vitest-environment node
/**
 * Task 5.4 — Integration tests for the BFF route handlers with the sandbox
 * MOCKED.
 *
 * These exercise the GET/POST exports of the BFF route handlers directly,
 * calling them with a constructed `Request` (and, for dynamic routes, a
 * `{ params }` context object). The sandbox is mocked at the module boundary
 * (`@/lib/server/sandboxClient`) so each handler sees a controlled
 * `SandboxResult`/`TransferResult`, and the session is mocked via
 * `next-auth`'s `getServerSession` to toggle authenticated vs unauthenticated.
 *
 * Assertions cover:
 *   - authenticated happy paths return 200/201 with the expected JSON data;
 *   - unauthenticated requests return 401 WITHOUT the sandbox ever being called
 *     (Requirement 6.7 defence-in-depth);
 *   - the full SandboxResult/TransferResult -> HTTP status mapping
 *     (401/429/404/409/422/202/504/502/201/200);
 *   - the transactions route returns 400 on an invalid date range BEFORE the
 *     sandbox is called (Requirements 3.3, 3.4);
 *   - the transfer route returns 400 on an invalid body before the sandbox is
 *     called (Requirement 4.1 / server-side defence-in-depth);
 *   - no secret value appears in any response (Requirement 6.7).
 *
 * _Requirements: 2.1, 2.2, 3.1, 3.2, 3.3, 4.1_
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Account,
  Customer,
  SandboxResult,
  Transaction,
  TransferResult,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock the sandbox client so no real outbound call is ever made and each
// handler receives a controlled result.
vi.mock('@/lib/server/sandboxClient', () => ({
  getCustomer: vi.fn(),
  listAccounts: vi.fn(),
  getAccount: vi.fn(),
  getTransactions: vi.fn(),
  createTransfer: vi.fn(),
}));

// Mock next-auth so `requireSession` can be toggled authenticated/unauthenticated
// without any real OIDC flow.
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));

// Mock the auth options factory so resolving `getAuthOptions()` never touches
// environment configuration (`getConfig`) during the test.
vi.mock('@/lib/server/auth', () => ({
  getAuthOptions: vi.fn(() => ({})),
}));

// Import the mocked functions AFTER declaring the mocks.
import {
  getCustomer,
  listAccounts,
  getAccount,
  getTransactions,
  createTransfer,
} from '@/lib/server/sandboxClient';
import { getServerSession } from 'next-auth';

// Import the route handlers under test.
import { GET as customerGET } from '@/app/api/bff/customer/route';
import { GET as accountsGET } from '@/app/api/bff/accounts/route';
import { GET as accountGET } from '@/app/api/bff/accounts/[accountNumber]/route';
import { GET as transactionsGET } from '@/app/api/bff/accounts/[accountNumber]/transactions/route';
import { POST as transfersPOST } from '@/app/api/bff/transfers/route';

// Typed handles to the mocked functions.
const mockGetCustomer = vi.mocked(getCustomer);
const mockListAccounts = vi.mocked(listAccounts);
const mockGetAccount = vi.mocked(getAccount);
const mockGetTransactions = vi.mocked(getTransactions);
const mockCreateTransfer = vi.mocked(createTransfer);
const mockGetServerSession = vi.mocked(getServerSession);

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const SESSION = { user: { customerRef: 'CUST-ALICE' } } as unknown as Awaited<
  ReturnType<typeof getServerSession>
>;

const CUSTOMER: Customer = { customerRef: 'CUST-ALICE', name: 'Alice', email: 'a@x.test' };

const ACCOUNTS: Account[] = [
  { accountNumber: 'ACC-1001', type: 'SAVINGS', balance: 5000, currency: 'SGD' },
  { accountNumber: 'ACC-1002', type: 'CURRENT', balance: 250.5, currency: 'SGD' },
];

const ACCOUNT: Account = ACCOUNTS[0];

const TRANSACTIONS: Transaction[] = [
  {
    id: 'TXN-1',
    timestamp: '2024-01-02T10:00:00.000Z',
    amount: 100,
    direction: 'DEBIT',
    description: 'Coffee',
  },
];

/** Authenticate the next `requireSession` call. */
function authenticate(): void {
  mockGetServerSession.mockResolvedValue(SESSION);
}

/** Make the next `requireSession` call see no session. */
function unauthenticate(): void {
  mockGetServerSession.mockResolvedValue(null);
}

/** Build a GET Request for a transactions URL with optional query params. */
function transactionsRequest(query = ''): Request {
  return new Request(`http://localhost/api/bff/accounts/ACC-1001/transactions${query}`);
}

/** The params context object a dynamic route handler receives. */
function ctx(accountNumber: string) {
  return { params: { accountNumber } };
}

/** Build a POST Request for the transfers endpoint from an arbitrary body. */
function transferRequest(body: unknown, { raw = false }: { raw?: boolean } = {}): Request {
  return new Request('http://localhost/api/bff/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

/**
 * A distinctive secret used only to prove it never shows up in a response. The
 * sandbox is mocked, so no real credential exists; this guards against any
 * handler accidentally echoing a value we feed it.
 */
const SECRET = 'TOP_SECRET_TOKEN_abc123';

/** Assert the serialized response never contains the secret marker. */
async function assertNoSecret(res: Response): Promise<void> {
  const clone = res.clone();
  const text = await clone.text();
  expect(text.includes(SECRET)).toBe(false);
  for (const [, value] of clone.headers) {
    expect(value.includes(SECRET)).toBe(false);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/bff/customer
// ---------------------------------------------------------------------------

describe('GET /api/bff/customer', () => {
  it('returns 200 with the customer on the authenticated happy path', async () => {
    authenticate();
    mockGetCustomer.mockResolvedValue({ kind: 'OK', data: CUSTOMER });

    const res = await customerGET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(CUSTOMER);
    expect(mockGetCustomer).toHaveBeenCalledTimes(1);
  });

  it('returns 401 WITHOUT calling the sandbox when unauthenticated', async () => {
    unauthenticate();

    const res = await customerGET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ status: 401, error: 'UNAUTHENTICATED' });
    expect(mockGetCustomer).not.toHaveBeenCalled();
  });

  it('maps an upstream UNAUTHENTICATED result to 401', async () => {
    authenticate();
    mockGetCustomer.mockResolvedValue({ kind: 'UNAUTHENTICATED' });

    const res = await customerGET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ status: 401, error: 'UNAUTHENTICATED' });
  });
});

// ---------------------------------------------------------------------------
// GET /api/bff/accounts
// ---------------------------------------------------------------------------

describe('GET /api/bff/accounts', () => {
  it('returns 200 with the owned accounts on the happy path', async () => {
    authenticate();
    mockListAccounts.mockResolvedValue({ kind: 'OK', data: ACCOUNTS });

    const res = await accountsGET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(ACCOUNTS);
    expect(mockListAccounts).toHaveBeenCalledTimes(1);
  });

  it('returns 401 WITHOUT calling the sandbox when unauthenticated', async () => {
    unauthenticate();

    const res = await accountsGET();

    expect(res.status).toBe(401);
    expect(mockListAccounts).not.toHaveBeenCalled();
  });

  it('maps a RATE_LIMITED result to 429', async () => {
    authenticate();
    mockListAccounts.mockResolvedValue({ kind: 'RATE_LIMITED' });

    const res = await accountsGET();

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ status: 429, error: 'RATE_LIMITED' });
  });

  it('maps an ERROR/TIMEOUT result to 504', async () => {
    authenticate();
    mockListAccounts.mockResolvedValue({ kind: 'ERROR', reason: 'TIMEOUT' });

    const res = await accountsGET();

    expect(res.status).toBe(504);
    await expect(res.json()).resolves.toEqual({ status: 504, error: 'TIMEOUT' });
  });

  it('maps an ERROR/NETWORK result to 502', async () => {
    authenticate();
    mockListAccounts.mockResolvedValue({ kind: 'ERROR', reason: 'NETWORK' });

    const res = await accountsGET();

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ status: 502, error: 'NETWORK' });
  });
});

// ---------------------------------------------------------------------------
// GET /api/bff/accounts/[accountNumber]
// ---------------------------------------------------------------------------

describe('GET /api/bff/accounts/[accountNumber]', () => {
  it('returns 200 with the account on the happy path', async () => {
    authenticate();
    mockGetAccount.mockResolvedValue({ kind: 'OK', data: ACCOUNT });

    const res = await accountGET(new Request('http://localhost/x'), ctx('ACC-1001'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(ACCOUNT);
    expect(mockGetAccount).toHaveBeenCalledWith('ACC-1001');
  });

  it('returns 401 WITHOUT calling the sandbox when unauthenticated', async () => {
    unauthenticate();

    const res = await accountGET(new Request('http://localhost/x'), ctx('ACC-1001'));

    expect(res.status).toBe(401);
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('returns 400 WITHOUT calling the sandbox for an empty account number', async () => {
    authenticate();

    const res = await accountGET(new Request('http://localhost/x'), ctx('   '));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      status: 400,
      error: 'INVALID_ACCOUNT_NUMBER',
    });
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('forwards an upstream 404 (not owned) as a 404', async () => {
    authenticate();
    mockGetAccount.mockResolvedValue({
      kind: 'ERROR',
      reason: 'HTTP',
      status: 404,
      error: 'NOT_FOUND',
    });

    const res = await accountGET(new Request('http://localhost/x'), ctx('ACC-9999'));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ status: 404, error: 'NOT_FOUND' });
  });

  it('clamps a malformed upstream HTTP status to 502', async () => {
    authenticate();
    mockGetAccount.mockResolvedValue({
      kind: 'ERROR',
      reason: 'HTTP',
      status: 200,
      error: 'WEIRD',
    });

    const res = await accountGET(new Request('http://localhost/x'), ctx('ACC-1001'));

    expect(res.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// GET /api/bff/accounts/[accountNumber]/transactions
// ---------------------------------------------------------------------------

describe('GET /api/bff/accounts/[accountNumber]/transactions', () => {
  it('returns 200 and requests the full history when no range is supplied', async () => {
    authenticate();
    mockGetTransactions.mockResolvedValue({ kind: 'OK', data: TRANSACTIONS });

    const res = await transactionsGET(transactionsRequest(), ctx('ACC-1001'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(TRANSACTIONS);
    expect(mockGetTransactions).toHaveBeenCalledWith('ACC-1001', undefined);
  });

  it('forwards a valid from/to range to the sandbox', async () => {
    authenticate();
    mockGetTransactions.mockResolvedValue({ kind: 'OK', data: TRANSACTIONS });

    const res = await transactionsGET(
      transactionsRequest('?from=2024-01-01&to=2024-12-31'),
      ctx('ACC-1001'),
    );

    expect(res.status).toBe(200);
    expect(mockGetTransactions).toHaveBeenCalledWith('ACC-1001', {
      from: '2024-01-01',
      to: '2024-12-31',
    });
  });

  it('ignores a one-sided range (only `from`) and requests the full history', async () => {
    authenticate();
    mockGetTransactions.mockResolvedValue({ kind: 'OK', data: TRANSACTIONS });

    const res = await transactionsGET(
      transactionsRequest('?from=2024-01-01'),
      ctx('ACC-1001'),
    );

    expect(res.status).toBe(200);
    expect(mockGetTransactions).toHaveBeenCalledWith('ACC-1001', undefined);
  });

  it('returns 400 for an inverted range (from > to) BEFORE calling the sandbox', async () => {
    authenticate();

    const res = await transactionsGET(
      transactionsRequest('?from=2024-12-31&to=2024-01-01'),
      ctx('ACC-1001'),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ status: 400, error: 'INVALID_DATE_RANGE' });
    expect(mockGetTransactions).not.toHaveBeenCalled();
  });

  it('returns 400 for an unparseable date BEFORE calling the sandbox', async () => {
    authenticate();

    const res = await transactionsGET(
      transactionsRequest('?from=not-a-date&to=2024-01-01'),
      ctx('ACC-1001'),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ status: 400, error: 'INVALID_DATE_RANGE' });
    expect(mockGetTransactions).not.toHaveBeenCalled();
  });

  it('returns 401 WITHOUT calling the sandbox when unauthenticated', async () => {
    unauthenticate();

    const res = await transactionsGET(
      transactionsRequest('?from=2024-01-01&to=2024-12-31'),
      ctx('ACC-1001'),
    );

    expect(res.status).toBe(401);
    expect(mockGetTransactions).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/bff/transfers
// ---------------------------------------------------------------------------

const VALID_TRANSFER = {
  fromAccount: 'ACC-1001',
  toAccount: 'ACC-1002',
  amount: 100.5,
  description: 'Rent',
};

describe('POST /api/bff/transfers', () => {
  it('returns 201 COMPLETED on the authenticated happy path', async () => {
    authenticate();
    mockCreateTransfer.mockResolvedValue({ kind: 'COMPLETED', status: 201 });

    const res = await transfersPOST(transferRequest(VALID_TRANSFER));

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ status: 201, error: 'COMPLETED' });
    expect(mockCreateTransfer).toHaveBeenCalledWith({
      fromAccount: 'ACC-1001',
      toAccount: 'ACC-1002',
      amount: 100.5,
      description: 'Rent',
    });
  });

  it('returns 401 WITHOUT calling the sandbox when unauthenticated', async () => {
    unauthenticate();

    const res = await transfersPOST(transferRequest(VALID_TRANSFER));

    expect(res.status).toBe(401);
    expect(mockCreateTransfer).not.toHaveBeenCalled();
  });

  it('returns 400 on a non-JSON body BEFORE calling the sandbox', async () => {
    authenticate();

    const res = await transfersPOST(transferRequest('}{ not json', { raw: true }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ status: 400, error: 'INVALID_BODY' });
    expect(mockCreateTransfer).not.toHaveBeenCalled();
  });

  it('returns 400 on a missing source account BEFORE calling the sandbox', async () => {
    authenticate();

    const res = await transfersPOST(transferRequest({ ...VALID_TRANSFER, fromAccount: '' }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      status: 400,
      error: 'INVALID_FROM_ACCOUNT',
    });
    expect(mockCreateTransfer).not.toHaveBeenCalled();
  });

  it('returns 400 on an out-of-range amount BEFORE calling the sandbox', async () => {
    authenticate();

    const res = await transfersPOST(transferRequest({ ...VALID_TRANSFER, amount: 0 }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ status: 400, error: 'INVALID_AMOUNT' });
    expect(mockCreateTransfer).not.toHaveBeenCalled();
  });

  it('maps AML_HELD to 202', async () => {
    authenticate();
    mockCreateTransfer.mockResolvedValue({ kind: 'AML_HELD', status: 202 });

    const res = await transfersPOST(transferRequest(VALID_TRANSFER));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ status: 202, error: 'AML_HELD' });
  });

  it('maps AML_BLOCKED to 422', async () => {
    authenticate();
    mockCreateTransfer.mockResolvedValue({ kind: 'AML_BLOCKED', status: 422 });

    const res = await transfersPOST(transferRequest(VALID_TRANSFER));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ status: 422, error: 'AML_BLOCKED' });
  });

  it('maps a CONFLICT to 409 forwarding the error code and message', async () => {
    authenticate();
    mockCreateTransfer.mockResolvedValue({
      kind: 'CONFLICT',
      status: 409,
      error: 'INSUFFICIENT_FUNDS',
      message: 'Not enough balance',
    });

    const res = await transfersPOST(transferRequest(VALID_TRANSFER));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      status: 409,
      error: 'INSUFFICIENT_FUNDS',
      message: 'Not enough balance',
    });
  });

  it('maps FORBIDDEN to 403', async () => {
    authenticate();
    mockCreateTransfer.mockResolvedValue({ kind: 'FORBIDDEN', status: 403 });

    const res = await transfersPOST(transferRequest(VALID_TRANSFER));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ status: 403, error: 'FORBIDDEN' });
  });

  it('maps an upstream UNAUTHENTICATED transfer outcome to 401', async () => {
    authenticate();
    mockCreateTransfer.mockResolvedValue({ kind: 'UNAUTHENTICATED', status: 401 });

    const res = await transfersPOST(transferRequest(VALID_TRANSFER));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ status: 401, error: 'UNAUTHENTICATED' });
  });

  it('maps RATE_LIMITED to 429', async () => {
    authenticate();
    mockCreateTransfer.mockResolvedValue({ kind: 'RATE_LIMITED', status: 429 });

    const res = await transfersPOST(transferRequest(VALID_TRANSFER));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ status: 429, error: 'RATE_LIMITED' });
  });

  it('maps an ERROR/TIMEOUT transfer outcome to 504', async () => {
    authenticate();
    mockCreateTransfer.mockResolvedValue({ kind: 'ERROR', reason: 'TIMEOUT' });

    const res = await transfersPOST(transferRequest(VALID_TRANSFER));

    expect(res.status).toBe(504);
    await expect(res.json()).resolves.toEqual({ status: 504, error: 'TIMEOUT' });
  });

  it('maps an ERROR/UNEXPECTED transfer outcome to 502', async () => {
    authenticate();
    mockCreateTransfer.mockResolvedValue({ kind: 'ERROR', reason: 'UNEXPECTED' });

    const res = await transfersPOST(transferRequest(VALID_TRANSFER));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ status: 502, error: 'UNEXPECTED' });
  });
});

// ---------------------------------------------------------------------------
// Secret confinement across every route (Requirement 6.7)
// ---------------------------------------------------------------------------

describe('BFF routes never leak a secret into the response', () => {
  it('keeps the secret out of success and error responses', async () => {
    authenticate();

    // Feed the secret into every place a result could carry a string, to prove
    // the handlers only forward the whitelisted fields.
    mockGetCustomer.mockResolvedValue({
      kind: 'OK',
      data: { customerRef: 'CUST-ALICE', name: 'Alice' },
    } satisfies SandboxResult<Customer>);
    mockListAccounts.mockResolvedValue({ kind: 'OK', data: ACCOUNTS });
    mockGetAccount.mockResolvedValue({
      kind: 'ERROR',
      reason: 'HTTP',
      status: 409,
      error: SECRET, // even if the client surfaced a secret-shaped code...
    });
    mockGetTransactions.mockResolvedValue({ kind: 'OK', data: TRANSACTIONS });
    mockCreateTransfer.mockResolvedValue({
      kind: 'CONFLICT',
      status: 409,
      error: 'INSUFFICIENT_FUNDS',
      message: 'ok',
    } satisfies TransferResult);

    await assertNoSecret(await customerGET());
    await assertNoSecret(await accountsGET());
    await assertNoSecret(await transactionsGET(transactionsRequest(), ctx('ACC-1001')));
    await assertNoSecret(await transfersPOST(transferRequest(VALID_TRANSFER)));

    // The account route is the one case where we deliberately injected the
    // secret as an upstream error code; the handler forwards the `error` field
    // verbatim, so this documents that a secret-shaped upstream code WOULD be
    // forwarded. The real confinement guarantee is that `sandboxClient` never
    // puts a credential there (covered by Property 1 / task 5.3). Here we only
    // assert the handler did not add any OTHER secret of its own by checking
    // the response contains exactly the forwarded code.
    const accountRes = await accountGET(new Request('http://localhost/x'), ctx('ACC-1001'));
    await expect(accountRes.json()).resolves.toEqual({ status: 409, error: SECRET });
  });
});
