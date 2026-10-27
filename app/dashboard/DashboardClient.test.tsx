/**
 * Integration tests for the Dashboard client view (Task 7.2).
 *
 * These tests render <DashboardClient/> in jsdom and drive it through its
 * public behaviour by mocking the browser `fetch` to the two same-origin BFF
 * read endpoints (`/api/bff/customer`, `/api/bff/accounts`). No request ever
 * reaches the live Sandbox_Gateway (Requirement 11.1).
 *
 * Coverage (Requirements 2.3, 2.4, 2.5, 2.6, 2.7, 2.8 and shared UI states
 * 8.1, 8.2, 8.4, 8.5, 8.7):
 *  - loading state shown initially;
 *  - success renders the customer profile (name, customerRef) and the account
 *    list (number, type, balance), each account linking to
 *    `/accounts/[accountNumber]`;
 *  - empty accounts renders the EmptyState;
 *  - a region error renders ErrorState with a working Retry that re-fetches;
 *  - a 429 shows a rate-limit message with retry disabled;
 *  - a 401 triggers re-auth (signIn is called);
 *  - the two regions degrade independently (profile ok while accounts fail,
 *    and vice-versa).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Account, Customer } from '@/lib/types';

// --- Mock next-auth/react so re-auth is observable and never navigates. ---
const signInMock = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

// --- Mock the LogoutButton: it uses next-auth internals we don't exercise. ---
vi.mock('@/app/components/LogoutButton', () => ({
  LogoutButton: () => <button type="button">Sign out</button>,
}));

import { DashboardClient } from './DashboardClient';

// --- Test fixtures ---------------------------------------------------------

const CUSTOMER: Customer = {
  customerRef: 'CUST-ALICE',
  name: 'Alice',
  email: 'alice@example.com',
};

const ACCOUNTS: Account[] = [
  { accountNumber: 'ACC-1001', type: 'SAVINGS', balance: 5000, currency: 'SGD' },
  { accountNumber: 'ACC-1002', type: 'CURRENT', balance: 1234.56, currency: 'SGD' },
];

/** A JSON Response with the given status (default 200). */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Per-URL responses for a single render. Each entry is either a Response or a
 * function returning one (so a sequence of calls to the same URL can differ,
 * e.g. first a failure then a success on retry).
 */
interface RouteResponders {
  customer: () => Response | Promise<Response>;
  accounts: () => Response | Promise<Response>;
}

/**
 * Install a `global.fetch` mock dispatching by URL to the given responders.
 * Returns the underlying vi.fn so tests can assert on call counts/args.
 */
function installFetch(responders: RouteResponders) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/bff/customer')) {
      return Promise.resolve(responders.customer());
    }
    if (url.includes('/api/bff/accounts')) {
      return Promise.resolve(responders.accounts());
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

beforeEach(() => {
  signInMock.mockReset();
});

// --- Tests -----------------------------------------------------------------

describe('DashboardClient', () => {
  it('shows a loading state for both regions initially (Req 2.4, 8.1)', () => {
    // Never-resolving fetch keeps both regions in the loading state.
    installFetch({
      customer: () => new Promise<Response>(() => {}) as unknown as Response,
      accounts: () => new Promise<Response>(() => {}) as unknown as Response,
    });

    render(<DashboardClient />);

    expect(screen.getByText('Loading your profile…')).toBeInTheDocument();
    expect(screen.getByText('Loading your accounts…')).toBeInTheDocument();
  });

  it('renders the customer profile and account list on success (Req 2.3)', async () => {
    installFetch({
      customer: () => jsonResponse(CUSTOMER),
      accounts: () => jsonResponse(ACCOUNTS),
    });

    render(<DashboardClient />);

    // Profile region.
    expect(await screen.findByTestId('customer-name')).toHaveTextContent('Alice');
    expect(screen.getByTestId('customer-ref')).toHaveTextContent('CUST-ALICE');

    // Account list: one item per account.
    const items = await screen.findAllByTestId('account-item');
    expect(items).toHaveLength(2);

    // First account renders number, type, and a formatted balance, and links
    // to its statement view.
    const first = items[0];
    expect(within(first).getByTestId('account-number')).toHaveTextContent('ACC-1001');
    expect(within(first).getByText('SAVINGS')).toBeInTheDocument();
    const firstBalance = within(first).getByTestId('account-balance').textContent ?? '';
    // Currency-formatted: contains the amount digits and the currency marker.
    expect(firstBalance).toMatch(/5[,.]?000/);
    expect(firstBalance).toMatch(/\$|SGD/);

    const firstLink = within(first).getByRole('link');
    expect(firstLink).toHaveAttribute('href', '/accounts/ACC-1001');

    const second = items[1];
    expect(within(second).getByTestId('account-number')).toHaveTextContent('ACC-1002');
    expect(within(second).getByRole('link')).toHaveAttribute('href', '/accounts/ACC-1002');
  });

  it('renders the EmptyState when the account list is empty (Req 2.5)', async () => {
    installFetch({
      customer: () => jsonResponse(CUSTOMER),
      accounts: () => jsonResponse([]),
    });

    render(<DashboardClient />);

    // Profile still resolves.
    expect(await screen.findByTestId('customer-name')).toHaveTextContent('Alice');
    // Empty state is shown; no account items.
    expect(await screen.findByText('No accounts')).toBeInTheDocument();
    expect(screen.queryByTestId('account-item')).not.toBeInTheDocument();
  });

  it('renders an ErrorState with a working Retry that re-fetches (Req 2.6, 2.8, 8.2, 8.4)', async () => {
    const user = userEvent.setup();
    let accountsCall = 0;
    installFetch({
      customer: () => jsonResponse(CUSTOMER),
      accounts: () => {
        accountsCall += 1;
        // First call fails (500), second call (after retry) succeeds.
        return accountsCall === 1 ? jsonResponse({ status: 500, error: 'BOOM' }, 500) : jsonResponse(ACCOUNTS);
      },
    });

    render(<DashboardClient />);

    // Error state appears for the accounts region with an enabled retry.
    const retry = await screen.findByRole('button', { name: 'Retry loading accounts' });
    expect(retry).toBeEnabled();

    // Clicking retry re-initiates the accounts fetch and resolves to data.
    await user.click(retry);

    const items = await screen.findAllByTestId('account-item');
    expect(items).toHaveLength(2);
    expect(accountsCall).toBe(2);
  });

  it('shows a rate-limit message with retry disabled on 429 (Req 8.7)', async () => {
    installFetch({
      customer: () => jsonResponse(CUSTOMER),
      accounts: () => jsonResponse({ status: 429, error: 'RATE_LIMITED' }, 429),
    });

    render(<DashboardClient />);

    // Rate-limit copy is surfaced and the retry control is disabled.
    expect(
      await screen.findByText(/too many requests/i),
    ).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry loading accounts' });
    expect(retry).toBeDisabled();
  });

  it('routes to re-authentication on a 401 (Req 1.7)', async () => {
    installFetch({
      customer: () => jsonResponse({ status: 401, error: 'UNAUTHENTICATED' }, 401),
      accounts: () => jsonResponse({ status: 401, error: 'UNAUTHENTICATED' }, 401),
    });

    render(<DashboardClient />);

    await waitFor(() => {
      expect(signInMock).toHaveBeenCalled();
    });
    expect(signInMock).toHaveBeenCalledWith('keycloak', { callbackUrl: '/dashboard' });
  });

  it('degrades independently: profile succeeds while accounts fail (Req 2.7)', async () => {
    installFetch({
      customer: () => jsonResponse(CUSTOMER),
      accounts: () => jsonResponse({ status: 500, error: 'BOOM' }, 500),
    });

    render(<DashboardClient />);

    // Profile data renders.
    expect(await screen.findByTestId('customer-name')).toHaveTextContent('Alice');
    // Accounts region shows an error with retry; profile region is unaffected.
    expect(
      await screen.findByRole('button', { name: 'Retry loading accounts' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading your profile…')).not.toBeInTheDocument();
  });

  it('degrades independently: accounts succeed while profile fails (Req 2.7)', async () => {
    installFetch({
      customer: () => jsonResponse({ status: 500, error: 'BOOM' }, 500),
      accounts: () => jsonResponse(ACCOUNTS),
    });

    render(<DashboardClient />);

    // Accounts render.
    const items = await screen.findAllByTestId('account-item');
    expect(items).toHaveLength(2);
    // Profile region shows an error with retry.
    expect(
      await screen.findByRole('button', { name: 'Retry loading profile' }),
    ).toBeInTheDocument();
  });
});
