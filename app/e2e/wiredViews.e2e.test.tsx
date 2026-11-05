/**
 * Feature: customer-banking-app
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4 ; Properties P1-P7
 *
 * Task 13.2 — End-to-end mocked-sandbox verification (wired-views half).
 *
 * This suite is the application-level confirmation that the three
 * Sandbox_Gateway-dependent views are correctly wired and that EACH surfaces
 * its loading / empty / error states with NO live network request. The browser
 * `fetch` is mocked for every test (Requirement 11.1), so no call ever reaches
 * the live Sandbox_Gateway; the views only ever touch same-origin `/api/bff/*`
 * endpoints (Property P5 — see the dedicated static guard in
 * `app/__guards__/no-direct-gateway-calls.test.ts`, and the node-side coverage
 * in `lib/e2e/propertyCoverage.e2e.test.ts`).
 *
 * Scope note: this is INTEGRATION-level confirmation that ties the pieces
 * together, not a re-run of every per-view case. The exhaustive per-view
 * behaviour is covered in depth by:
 *   - app/dashboard/DashboardClient.test.tsx
 *   - app/accounts/[accountNumber]/StatementClient.test.tsx
 *   - app/transfer/TransferContainer.test.tsx
 * Here we assert a focused loading -> data / empty / error (+ retry / re-auth)
 * slice per view so the "wired application" is verified as a whole.
 *
 * The node-only portions (Properties P1/P2/P3/P4/P6/P7 invoked through the
 * shared pure & boundary functions, plus a BFF-route credential-confinement
 * re-assertion) live in `lib/e2e/propertyCoverage.e2e.test.ts` because they
 * require the `node` Vitest environment, which conflicts with the jsdom
 * environment these React Testing Library tests need.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Account, Customer, Transaction } from '@/lib/types';

// --- Mock next-auth/react so the re-auth path is observable and never
//     actually navigates (Property P5 keeps all data I/O on /api/bff/*). ---
const signInMock = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

// --- Mock the LogoutButton: it pulls in next-auth internals the view tests
//     don't exercise. ---
vi.mock('@/app/components/LogoutButton', () => ({
  LogoutButton: () => <button type="button">Sign out</button>,
}));

import { DashboardClient } from '@/app/dashboard/DashboardClient';
import { StatementClient } from '@/app/accounts/[accountNumber]/StatementClient';
import { TransferContainer } from '@/app/transfer/TransferContainer';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CUSTOMER: Customer = {
  customerRef: 'CUST-ALICE',
  name: 'Alice',
  email: 'alice@example.com',
};

const ACCOUNTS: Account[] = [
  { accountNumber: 'ACC-1001', type: 'SAVINGS', balance: 5000, currency: 'SGD' },
  { accountNumber: 'ACC-1002', type: 'CURRENT', balance: 1234.56, currency: 'SGD' },
];

const ACCOUNT: Account = ACCOUNTS[0];

const TRANSACTIONS: Transaction[] = [
  {
    id: 'TXN-1',
    timestamp: '2024-01-02T10:00:00.000Z',
    amount: 250.5,
    direction: 'CREDIT',
    description: 'Salary',
    runningBalance: 5250.5,
  },
];

/** A JSON Response with the given status (default 200). */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A never-resolving Response — keeps a region in its loading state. */
function pending(): Response {
  return new Promise<Response>(() => {}) as unknown as Response;
}

/**
 * All fetch URLs seen across a render. Every test asserts (via
 * `assertAllBffOnly`) that every captured URL is a same-origin `/api/bff/*`
 * path — the runtime complement to the P5 static guard, proving NO request
 * targeted the live gateway (Requirement 11.1, Property P5).
 */
let capturedUrls: string[] = [];

/**
 * Install a `global.fetch` mock. The `route` callback receives the request URL
 * and HTTP method and returns the Response (or a promise of one) the view
 * should see. Every URL is recorded for the BFF-only assertion.
 */
function installFetch(
  route: (url: string, method: string) => Response | Promise<Response>,
) {
  capturedUrls = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    capturedUrls.push(url);
    return Promise.resolve(route(url, method));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Runtime P5 assertion: every URL the wired views requested is a same-origin
 * `/api/bff/*` path, never the Sandbox_Gateway (`localhost:8081`) or the
 * Identity_Provider (`localhost:8080`) origin. Confirms "no live network".
 */
function assertAllBffOnly(): void {
  expect(capturedUrls.length).toBeGreaterThan(0);
  for (const url of capturedUrls) {
    // Strip the jsdom origin (http://localhost) the browser prepends to a
    // same-origin relative path, then require the /api/bff/ prefix.
    const path = url.replace(/^https?:\/\/[^/]+/i, '');
    expect(path.startsWith('/api/bff/')).toBe(true);
    expect(url).not.toContain('localhost:8081');
    expect(url).not.toContain('localhost:8080');
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

beforeEach(() => {
  signInMock.mockReset();
});

// ---------------------------------------------------------------------------
// Dashboard — loading -> data, empty, error + retry, 401 -> re-auth
// ---------------------------------------------------------------------------

describe('e2e wired view: Dashboard (Req 11.1, 11.3)', () => {
  it('renders profile + accounts on success, hitting only /api/bff/*', async () => {
    installFetch((url) =>
      url.includes('/api/bff/customer') ? jsonResponse(CUSTOMER) : jsonResponse(ACCOUNTS),
    );

    render(<DashboardClient />);

    // Data resolves for both regions.
    expect(await screen.findByTestId('customer-name')).toHaveTextContent('Alice');
    const items = await screen.findAllByTestId('account-item');
    expect(items).toHaveLength(2);

    assertAllBffOnly();
  });

  it('renders the empty state when the account list is empty', async () => {
    installFetch((url) =>
      url.includes('/api/bff/customer') ? jsonResponse(CUSTOMER) : jsonResponse([]),
    );

    render(<DashboardClient />);

    expect(await screen.findByText('No accounts')).toBeInTheDocument();
    expect(screen.queryByTestId('account-item')).not.toBeInTheDocument();
    assertAllBffOnly();
  });

  it('shows an error state with a working retry for the accounts region', async () => {
    const user = userEvent.setup();
    let accountsCall = 0;
    installFetch((url) => {
      if (url.includes('/api/bff/customer')) return jsonResponse(CUSTOMER);
      accountsCall += 1;
      return accountsCall === 1
        ? jsonResponse({ status: 500, error: 'BOOM' }, 500)
        : jsonResponse(ACCOUNTS);
    });

    render(<DashboardClient />);

    const retry = await screen.findByRole('button', { name: 'Retry loading accounts' });
    await user.click(retry);

    const items = await screen.findAllByTestId('account-item');
    expect(items).toHaveLength(2);
    assertAllBffOnly();
  });

  it('routes to re-authentication on a 401 (no banner, signIn invoked)', async () => {
    installFetch(() => jsonResponse({ status: 401, error: 'UNAUTHENTICATED' }, 401));

    render(<DashboardClient />);

    await waitFor(() => expect(signInMock).toHaveBeenCalled());
    expect(signInMock).toHaveBeenCalledWith('keycloak', { callbackUrl: '/dashboard' });
    assertAllBffOnly();
  });

  it('keeps the initial loading state while requests are pending', () => {
    installFetch(() => pending());
    render(<DashboardClient />);
    expect(screen.getByText('Loading your profile…')).toBeInTheDocument();
    expect(screen.getByText('Loading your accounts…')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Statement — loading -> data, empty range, invalid range (no request), error + retry
// ---------------------------------------------------------------------------

describe('e2e wired view: Statement (Req 11.1, 11.3)', () => {
  it('renders the account summary and transactions on success', async () => {
    installFetch((url) =>
      url.includes('/transactions') ? jsonResponse(TRANSACTIONS) : jsonResponse(ACCOUNT),
    );

    render(<StatementClient accountNumber="ACC-1001" />);

    expect(await screen.findByText('ACC-1001', { selector: 'dd' })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Salary')).toBeInTheDocument();
    assertAllBffOnly();
  });

  it('renders the empty state for a zero-transaction range', async () => {
    installFetch((url) =>
      url.includes('/transactions') ? jsonResponse([]) : jsonResponse(ACCOUNT),
    );

    render(<StatementClient accountNumber="ACC-1001" />);

    expect(await screen.findByText('No transactions')).toBeInTheDocument();
    assertAllBffOnly();
  });

  it('rejects an inverted range WITHOUT sending a request and retains data', async () => {
    const fetchMock = installFetch((url) =>
      url.includes('/transactions') ? jsonResponse(TRANSACTIONS) : jsonResponse(ACCOUNT),
    );

    render(<StatementClient accountNumber="ACC-1001" />);

    // Wait for the initial transactions load.
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Salary')).toBeInTheDocument();

    const txnCallsBefore = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/transactions'),
    ).length;

    // Set an inverted range (from > to) and apply the filter.
    fireEvent.change(screen.getByLabelText('From'), {
      target: { value: '2024-02-01T00:00' },
    });
    fireEvent.change(screen.getByLabelText('To'), {
      target: { value: '2024-01-01T00:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filter' }));

    // Inline validation error is shown and NO new transactions request fires.
    const alert = await screen.findByTestId('range-error');
    expect(alert).toHaveAttribute('role', 'alert');

    const txnCallsAfter = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/transactions'),
    ).length;
    expect(txnCallsAfter).toBe(txnCallsBefore);

    // Previously loaded data is retained.
    expect(within(screen.getByRole('table')).getByText('Salary')).toBeInTheDocument();
    assertAllBffOnly();
  });

  it('shows an error state with a working retry on a transactions 500', async () => {
    const user = userEvent.setup();
    let txnCall = 0;
    installFetch((url) => {
      if (!url.includes('/transactions')) return jsonResponse(ACCOUNT);
      txnCall += 1;
      return txnCall === 1
        ? jsonResponse({ status: 500, error: 'BOOM' }, 500)
        : jsonResponse(TRANSACTIONS);
    });

    render(<StatementClient accountNumber="ACC-1001" />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    await user.click(retry);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Salary')).toBeInTheDocument();
    expect(txnCall).toBe(2);
    assertAllBffOnly();
  });
});

// ---------------------------------------------------------------------------
// Transfer — success (201) and a representative failure (409 CONFLICT); the
// idempotent double-submit issues exactly one POST (Property P7 end-to-end).
// ---------------------------------------------------------------------------

describe('e2e wired view: Transfer (Req 11.1, 11.2)', () => {
  /** Count POSTs to the transfer endpoint across the captured URLs. */
  function transferPostCount(fetchMock: ReturnType<typeof installFetch>): number {
    return fetchMock.mock.calls.filter((call) => {
      const url = String(call[0]);
      const method = ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
      return url.includes('/api/bff/transfers') && method === 'POST';
    }).length;
  }

  /** Fill the form with a valid source/destination/amount ready to submit. */
  async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
    const select = await screen.findByLabelText('From account');
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: /ACC-1001/ })).toBeInTheDocument(),
    );
    await user.selectOptions(select, 'ACC-1001');
    await user.type(screen.getByLabelText('To account'), 'ACC-1002');
    await user.type(screen.getByLabelText('Amount'), '100.00');
  }

  it('renders the success banner on 201 COMPLETED', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetch((url, method) => {
      if (url.includes('/api/bff/accounts') && method === 'GET') return jsonResponse(ACCOUNTS);
      if (url.includes('/api/bff/payees') && method === 'GET') return jsonResponse([]);
      if (url.includes('/api/bff/transfers') && method === 'POST') {
        return jsonResponse({ status: 201, error: 'COMPLETED' }, 201);
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });

    render(<TransferContainer />);
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Send transfer' }));

    const banner = await screen.findByRole('status');
    expect(banner).toHaveAttribute('data-outcome', 'COMPLETED');
    expect(transferPostCount(fetchMock)).toBe(1);
    assertAllBffOnly();
  });

  it('renders the conflict banner with insufficient-funds copy on 409', async () => {
    const user = userEvent.setup();
    installFetch((url, method) => {
      if (url.includes('/api/bff/accounts') && method === 'GET') return jsonResponse(ACCOUNTS);
      if (url.includes('/api/bff/payees') && method === 'GET') return jsonResponse([]);
      if (url.includes('/api/bff/transfers') && method === 'POST') {
        return jsonResponse(
          { status: 409, error: 'INSUFFICIENT_FUNDS', message: 'no' },
          409,
        );
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });

    render(<TransferContainer />);
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Send transfer' }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'CONFLICT');
    expect(banner).toHaveTextContent(/enough funds/i);
    assertAllBffOnly();
  });

  it('issues exactly one POST for a double-submit while in flight (P7 e2e)', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetch((url, method) => {
      if (url.includes('/api/bff/accounts') && method === 'GET') return jsonResponse(ACCOUNTS);
      // The POST never resolves so the request stays in flight.
      return pending();
    });

    render(<TransferContainer />);
    await fillValidForm(user);

    const button = screen.getByRole('button', { name: 'Send transfer' });
    await user.click(button);
    await user.click(button);

    await waitFor(() => expect(transferPostCount(fetchMock)).toBe(1));
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    // A second POST must never slip through while in flight.
    expect(transferPostCount(fetchMock)).toBe(1);
    assertAllBffOnly();
  });
});
