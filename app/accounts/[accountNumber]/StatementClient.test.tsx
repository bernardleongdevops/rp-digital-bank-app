/**
 * Integration tests for the Statement view client component (Task 8.2).
 *
 * These tests render <StatementClient/> in jsdom and drive it through its
 * public behaviour by mocking the browser `fetch` to the two same-origin BFF
 * read endpoints:
 *   GET /api/bff/accounts/ACC-1001                 (account summary)
 *   GET /api/bff/accounts/ACC-1001/transactions    (transactions, optional ?from=&to=)
 * No request ever reaches the live Sandbox_Gateway (Requirement 11.1).
 *
 * Coverage (Requirements 3.1-3.8 and shared UI states 8.1-8.7):
 *  - initial loading states shown for both regions;
 *  - success renders the account summary (<dl>: number, type, balance,
 *    currency) and the transactions <table> (date, description, direction,
 *    amount, running balance, with '—' when runningBalance is absent);
 *  - an empty transactions array renders the EmptyState ("No transactions");
 *  - invalid date range (from > to) shows an inline role="alert" validation
 *    error, sends NO transactions request, and retains loaded transactions;
 *  - a valid range (from <= to) issues a transactions fetch whose URL carries
 *    from= and to= query params;
 *  - a region error (500) renders ErrorState with a working Retry that
 *    re-fetches and renders rows;
 *  - a 429 shows a rate-limit message with retry disabled;
 *  - a 401 on the account fetch routes to re-authentication (signIn called);
 *  - a 404 on the account fetch shows a graceful not-found message with no
 *    retry for that region.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Account, Transaction } from '@/lib/types';

// --- Mock next-auth/react so re-auth is observable and never navigates. ---
const signInMock = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

// --- Mock the LogoutButton: it uses next-auth internals we don't exercise. ---
vi.mock('@/app/components/LogoutButton', () => ({
  LogoutButton: () => <button type="button">Sign out</button>,
}));

import { StatementClient } from './StatementClient';

// --- Test fixtures ---------------------------------------------------------

const ACCOUNT_NUMBER = 'ACC-1001';

const ACCOUNT: Account = {
  accountNumber: ACCOUNT_NUMBER,
  type: 'SAVINGS',
  balance: 5000,
  currency: 'SGD',
};

const TRANSACTIONS: Transaction[] = [
  {
    id: 'TXN-1',
    timestamp: '2024-01-02T10:00:00.000Z',
    amount: 250.5,
    direction: 'CREDIT',
    description: 'Salary',
    runningBalance: 5250.5,
  },
  {
    id: 'TXN-2',
    timestamp: '2024-01-03T12:30:00.000Z',
    amount: 40,
    direction: 'DEBIT',
    description: 'Groceries',
    // runningBalance intentionally omitted -> should render '—'.
  },
];

/** A JSON Response with the given status (default 200). */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Per-URL responders for a single render. Each responder receives the request
 * URL so a test can assert the query string. Returning a Response (or a promise
 * of one) per call allows sequencing (e.g. first a 500, then a 200 on retry).
 */
interface RouteResponders {
  account: (url: string) => Response | Promise<Response>;
  transactions: (url: string) => Response | Promise<Response>;
}

/**
 * Install a `global.fetch` mock that dispatches by URL. The transactions URL is
 * distinguished from the account URL by the '/transactions' segment. Returns
 * the underlying vi.fn so tests can assert call counts / args.
 */
function installFetch(responders: RouteResponders) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/transactions')) {
      return Promise.resolve(responders.transactions(url));
    }
    if (url.includes('/api/bff/accounts/')) {
      return Promise.resolve(responders.account(url));
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Count the transactions fetch calls recorded by the mock. */
function transactionsCallCount(fetchMock: ReturnType<typeof installFetch>): number {
  return fetchMock.mock.calls.filter((call) => {
    const input = call[0] as RequestInfo | URL;
    const url = typeof input === 'string' ? input : input.toString();
    return url.includes('/transactions');
  }).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

beforeEach(() => {
  signInMock.mockReset();
});

// --- Tests -----------------------------------------------------------------

describe('StatementClient', () => {
  it('shows loading states for both regions initially (Req 3.1, 8.1)', () => {
    // Never-resolving fetch keeps both regions in the loading state.
    installFetch({
      account: () => new Promise<Response>(() => {}) as unknown as Response,
      transactions: () => new Promise<Response>(() => {}) as unknown as Response,
    });

    render(<StatementClient accountNumber={ACCOUNT_NUMBER} />);

    expect(screen.getByText('Loading account details…')).toBeInTheDocument();
    expect(screen.getByText('Loading transactions…')).toBeInTheDocument();
  });

  it('renders the account summary and transactions on success (Req 3.1, 3.2, 3.5)', async () => {
    installFetch({
      account: () => jsonResponse(ACCOUNT),
      transactions: () => jsonResponse(TRANSACTIONS),
    });

    render(<StatementClient accountNumber={ACCOUNT_NUMBER} />);

    // Account summary renders in a <dl> with number, type, balance, currency.
    const accountNumberDd = await screen.findByText(ACCOUNT_NUMBER, { selector: 'dd' });
    expect(accountNumberDd).toBeInTheDocument();
    expect(screen.getByText('SAVINGS', { selector: 'dd' })).toBeInTheDocument();
    // Currency appears both as a <dd> and inside the formatted balance.
    expect(screen.getAllByText('SGD', { exact: false }).length).toBeGreaterThan(0);
    // Balance is currency-formatted (contains the amount digits).
    const balanceCells = screen.getAllByText(/5[,.]?000/);
    expect(balanceCells.length).toBeGreaterThan(0);

    // Transactions render in a <table> with a caption and one row per txn.
    const table = await screen.findByRole('table');
    expect(within(table).getByText(/Transactions for account ACC-1001/)).toBeInTheDocument();

    const rows = within(table).getAllByRole('row');
    // 1 header row + 2 data rows.
    expect(rows).toHaveLength(3);

    // First row: CREDIT with a running balance.
    const firstRow = rows[1];
    expect(within(firstRow).getByText('Salary')).toBeInTheDocument();
    expect(within(firstRow).getByText('CREDIT')).toBeInTheDocument();

    // Second row: DEBIT with an absent running balance -> em dash.
    const secondRow = rows[2];
    expect(within(secondRow).getByText('Groceries')).toBeInTheDocument();
    expect(within(secondRow).getByText('DEBIT')).toBeInTheDocument();
    expect(within(secondRow).getByText('—')).toBeInTheDocument();
  });

  it('renders the EmptyState when there are no transactions (Req 3.7, 8.5)', async () => {
    installFetch({
      account: () => jsonResponse(ACCOUNT),
      transactions: () => jsonResponse([]),
    });

    render(<StatementClient accountNumber={ACCOUNT_NUMBER} />);

    // Account summary still resolves.
    expect(await screen.findByText(ACCOUNT_NUMBER, { selector: 'dd' })).toBeInTheDocument();
    // Empty state is shown; no transactions table.
    expect(await screen.findByText('No transactions')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('rejects an inverted range without sending a request and retains loaded data (Req 3.3, 3.4)', async () => {
    const fetchMock = installFetch({
      account: () => jsonResponse(ACCOUNT),
      transactions: () => jsonResponse(TRANSACTIONS),
    });

    render(<StatementClient accountNumber={ACCOUNT_NUMBER} />);

    // Wait for the initial transactions load to complete (rows present).
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Salary')).toBeInTheDocument();

    const callsBefore = transactionsCallCount(fetchMock);

    // Set from > to.
    const fromInput = screen.getByLabelText('From');
    const toInput = screen.getByLabelText('To');
    fireEvent.change(fromInput, { target: { value: '2024-02-01T00:00' } });
    fireEvent.change(toInput, { target: { value: '2024-01-01T00:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Apply filter' }));

    // Inline validation error appears with role="alert" and the testid.
    const alert = await screen.findByTestId('range-error');
    expect(alert).toHaveAttribute('role', 'alert');

    // No new transactions fetch was issued for this invalid submit.
    expect(transactionsCallCount(fetchMock)).toBe(callsBefore);

    // Previously loaded transactions are retained.
    expect(within(screen.getByRole('table')).getByText('Salary')).toBeInTheDocument();
  });

  it('issues a transactions fetch with from/to query params for a valid range (Req 3.3)', async () => {
    const fetchMock = installFetch({
      account: () => jsonResponse(ACCOUNT),
      transactions: () => jsonResponse(TRANSACTIONS),
    });

    render(<StatementClient accountNumber={ACCOUNT_NUMBER} />);

    // Wait for the initial load.
    await screen.findByRole('table');
    const callsBefore = transactionsCallCount(fetchMock);

    const fromInput = screen.getByLabelText('From');
    const toInput = screen.getByLabelText('To');
    fireEvent.change(fromInput, { target: { value: '2024-01-01T00:00' } });
    fireEvent.change(toInput, { target: { value: '2024-01-31T00:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Apply filter' }));

    // A new transactions fetch is issued with from= and to= query params.
    await waitFor(() => {
      expect(transactionsCallCount(fetchMock)).toBe(callsBefore + 1);
    });

    const lastTransactionsUrl = fetchMock.mock.calls
      .map((call) => {
        const input = call[0] as RequestInfo | URL;
        return typeof input === 'string' ? input : input.toString();
      })
      .filter((url) => url.includes('/transactions'))
      .pop() as string;

    expect(lastTransactionsUrl).toContain('from=');
    expect(lastTransactionsUrl).toContain('to=');
    // No inline validation error for a valid range.
    expect(screen.queryByTestId('range-error')).not.toBeInTheDocument();
  });

  it('renders an ErrorState with a working Retry on a transactions 500 (Req 3.8, 8.2)', async () => {
    const user = userEvent.setup();
    let txnCall = 0;
    installFetch({
      account: () => jsonResponse(ACCOUNT),
      transactions: () => {
        txnCall += 1;
        // First call fails (500), second call (after retry) succeeds.
        return txnCall === 1
          ? jsonResponse({ status: 500, error: 'BOOM' }, 500)
          : jsonResponse(TRANSACTIONS);
      },
    });

    render(<StatementClient accountNumber={ACCOUNT_NUMBER} />);

    // The transactions region shows an error with an enabled retry.
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(retry).toBeEnabled();

    // Clicking retry re-initiates the transactions fetch and renders rows.
    await user.click(retry);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Salary')).toBeInTheDocument();
    expect(txnCall).toBe(2);
  });

  it('shows a rate-limit message with retry disabled on a transactions 429 (Req 8.7)', async () => {
    installFetch({
      account: () => jsonResponse(ACCOUNT),
      transactions: () => jsonResponse({ status: 429, error: 'RATE_LIMITED' }, 429),
    });

    render(<StatementClient accountNumber={ACCOUNT_NUMBER} />);

    // Rate-limit copy is surfaced for the transactions region.
    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument();
    // The retry control (if present) is disabled; otherwise there is no retry.
    const retry = screen.queryByRole('button', { name: 'Retry' });
    if (retry) {
      expect(retry).toBeDisabled();
    }
  });

  it('routes to re-authentication on a 401 from the account fetch (Req 1.7)', async () => {
    installFetch({
      account: () => jsonResponse({ status: 401, error: 'UNAUTHENTICATED' }, 401),
      transactions: () => jsonResponse(TRANSACTIONS),
    });

    render(<StatementClient accountNumber={ACCOUNT_NUMBER} />);

    await waitFor(() => {
      expect(signInMock).toHaveBeenCalled();
    });
    // jsdom's default pathname is '/'.
    expect(signInMock).toHaveBeenCalledWith('keycloak', {
      callbackUrl: window.location.pathname,
    });
  });

  it('shows a graceful not-found message with no retry on a 404 account fetch (Req 3.8)', async () => {
    installFetch({
      account: () => jsonResponse({ status: 404, error: 'NOT_FOUND' }, 404),
      transactions: () => jsonResponse(TRANSACTIONS),
    });

    render(<StatementClient accountNumber={ACCOUNT_NUMBER} />);

    // Not-found copy is surfaced for the account region.
    const notFound = await screen.findByText(/could not be found/i);
    expect(notFound).toBeInTheDocument();

    // The account-summary error region must not offer a retry. Scope the query
    // to the account summary section to avoid other regions' controls.
    const summarySection = notFound.closest('section');
    expect(summarySection).not.toBeNull();
    expect(
      within(summarySection as HTMLElement).queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
  });
});
