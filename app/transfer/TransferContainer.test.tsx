/**
 * Integration tests for the Transfer submission container (Task 9.5).
 *
 * These tests render <TransferContainer/> in jsdom and drive it end-to-end
 * through its public behaviour by mocking the browser `fetch` to the two
 * same-origin BFF endpoints it touches:
 *   - GET  /api/bff/accounts  — populates the source-account <select> so a
 *     valid source can be chosen (TransferForm, task 9.1);
 *   - POST /api/bff/transfers — the transfer itself, whose HTTP status + JSON
 *     body `{ status, error?, message? }` drive the outcome banner via
 *     `mapTransferOutcome` (task 6.1).
 * No request ever reaches the live Sandbox_Gateway (Requirement 11.1).
 *
 * Coverage (Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 5.*):
 *  - 201 COMPLETED  -> success banner + form cleared (remounted via key);
 *  - 202 AML_HELD   -> held banner;
 *  - 422 AML_BLOCKED-> blocked banner;
 *  - 409 CONFLICT (INSUFFICIENT_FUNDS) -> specific insufficient-funds copy;
 *  - 403 FORBIDDEN  -> forbidden banner;
 *  - 401            -> routes to re-authentication (signIn), no banner;
 *  - 429 RATE_LIMITED -> rate-limit banner with NO enabled Retry;
 *  - 502/504        -> generic error banner with a working Retry that re-POSTs;
 *  - client-side validation blocks submission with NO POST issued;
 *  - idempotent guard: a double-click while in flight issues exactly one POST.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Account } from '@/lib/types';

// --- Mock next-auth/react so the 401 re-auth path is observable and never
//     actually navigates. ---
const signInMock = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

import { TransferContainer } from './TransferContainer';

// --- Test fixtures ---------------------------------------------------------

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

/** The parsed shape of one captured POST /api/bff/transfers call. */
interface CapturedTransfer {
  body: {
    fromAccount: string;
    toAccount: string;
    amount: number;
    description: string;
  };
}

/**
 * A responder for POST /api/bff/transfers. Returns either a Response or a
 * Promise of one (so a test can make the POST hang via a never-resolving
 * promise to exercise the in-flight guard).
 */
type TransferResponder = () => Response | Promise<Response>;

/** Captures every POST to the transfer endpoint across a single render. */
const transferCalls: CapturedTransfer[] = [];

/**
 * Install a `global.fetch` mock dispatching by URL + method:
 *   - GET  /api/bff/accounts  -> the two owned accounts (so the select fills);
 *   - POST /api/bff/transfers -> the per-test `transfer` responder, with the
 *     request body captured for assertions.
 * Returns the underlying vi.fn so tests can inspect call counts/args.
 */
function installFetch(transfer: TransferResponder) {
  transferCalls.length = 0;
  const fetchMock = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.includes('/api/bff/accounts') && method === 'GET') {
        return Promise.resolve(jsonResponse(ACCOUNTS));
      }

      if (url.includes('/api/bff/transfers') && method === 'POST') {
        const raw = typeof init?.body === 'string' ? init.body : '{}';
        transferCalls.push({ body: JSON.parse(raw) as CapturedTransfer['body'] });
        return Promise.resolve(transfer());
      }

      throw new Error(`Unexpected fetch URL/method in test: ${method} ${url}`);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Count of captured POSTs to the transfer endpoint. */
function transferPostCount(): number {
  return transferCalls.length;
}

/**
 * Fill the form with valid values: wait for the source <select> to populate,
 * choose a source account, type a different destination, a valid amount, and
 * an optional description. Leaves the form ready to submit.
 */
async function fillValidForm(
  user: ReturnType<typeof userEvent.setup>,
  overrides: Partial<{ to: string; amount: string; description: string }> = {},
) {
  // The source select only renders its options once GET /api/bff/accounts
  // resolves; wait for the first owned account to appear as an option.
  const select = await screen.findByLabelText('From account');
  await waitFor(() => {
    expect(within(select).getByRole('option', { name: /ACC-1001/ })).toBeInTheDocument();
  });

  await user.selectOptions(select, 'ACC-1001');
  await user.type(screen.getByLabelText('To account'), overrides.to ?? 'ACC-1002');
  await user.type(screen.getByLabelText('Amount'), overrides.amount ?? '100.00');
  if (overrides.description) {
    await user.type(
      screen.getByLabelText('Description (optional)'),
      overrides.description,
    );
  }
}

/** Click the submit button. */
async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Send transfer' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

beforeEach(() => {
  signInMock.mockReset();
});

// --- Tests -----------------------------------------------------------------

describe('TransferContainer', () => {
  it('renders a success banner and clears the form on 201 COMPLETED (Req 4.3)', async () => {
    const user = userEvent.setup();
    installFetch(() => jsonResponse({ status: 201, error: 'COMPLETED' }, 201));

    render(<TransferContainer />);
    await fillValidForm(user, { description: 'rent' });
    await submit(user);

    // Success banner with the COMPLETED outcome.
    const banner = await screen.findByRole('status');
    expect(banner).toHaveAttribute('data-outcome', 'COMPLETED');
    expect(banner).toHaveTextContent(/completed/i);

    // The form is cleared by remounting TransferForm (new key): the amount and
    // destination inputs are empty again.
    await waitFor(() => {
      expect(screen.getByLabelText('Amount')).toHaveValue('');
    });
    expect(screen.getByLabelText('To account')).toHaveValue('');

    expect(transferPostCount()).toBe(1);
  });

  it('renders the held banner on 202 AML_HELD (Req 4.4)', async () => {
    const user = userEvent.setup();
    installFetch(() => jsonResponse({ status: 202, error: 'AML_HELD' }, 202));

    render(<TransferContainer />);
    await fillValidForm(user);
    await submit(user);

    const banner = await screen.findByRole('status');
    expect(banner).toHaveAttribute('data-outcome', 'AML_HELD');
  });

  it('renders the blocked banner on 422 AML_BLOCKED (Req 4.5)', async () => {
    const user = userEvent.setup();
    installFetch(() => jsonResponse({ status: 422, error: 'AML_BLOCKED' }, 422));

    render(<TransferContainer />);
    await fillValidForm(user);
    await submit(user);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'AML_BLOCKED');
  });

  it('shows the insufficient-funds message on 409 CONFLICT (Req 4.6)', async () => {
    const user = userEvent.setup();
    installFetch(() =>
      jsonResponse(
        { status: 409, error: 'INSUFFICIENT_FUNDS', message: 'nope' },
        409,
      ),
    );

    render(<TransferContainer />);
    await fillValidForm(user);
    await submit(user);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'CONFLICT');
    expect(banner).toHaveTextContent(/enough funds/i);
  });

  it('renders the forbidden banner on 403 FORBIDDEN (Req 4.7)', async () => {
    const user = userEvent.setup();
    installFetch(() => jsonResponse({ status: 403, error: 'FORBIDDEN' }, 403));

    render(<TransferContainer />);
    await fillValidForm(user);
    await submit(user);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'FORBIDDEN');
  });

  it('routes to re-authentication on 401 (Req 4.8)', async () => {
    const user = userEvent.setup();
    installFetch(() => jsonResponse({ status: 401, error: 'UNAUTHENTICATED' }, 401));

    render(<TransferContainer />);
    await fillValidForm(user);
    await submit(user);

    await waitFor(() => {
      expect(signInMock).toHaveBeenCalledWith('keycloak', { callbackUrl: '/transfer' });
    });
    // No banner is shown for the re-auth path.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a rate-limit banner with no enabled Retry on 429 (Req 4.9)', async () => {
    const user = userEvent.setup();
    installFetch(() => jsonResponse({ status: 429, error: 'RATE_LIMITED' }, 429));

    render(<TransferContainer />);
    await fillValidForm(user);
    await submit(user);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'RATE_LIMITED');
    expect(banner).toHaveTextContent(/too many requests/i);
    // No Retry affordance for a rate-limited outcome.
    expect(within(banner).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows a generic error banner with a working Retry on 502 NETWORK (Req 4.10)', async () => {
    const user = userEvent.setup();
    installFetch(() => jsonResponse({ status: 502, error: 'NETWORK' }, 502));

    render(<TransferContainer />);
    await fillValidForm(user);
    await submit(user);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'NETWORK');

    expect(transferPostCount()).toBe(1);

    // The Retry control re-submits the same (retained) values -> a 2nd POST.
    const retry = within(banner).getByRole('button', { name: 'Retry' });
    await user.click(retry);

    await waitFor(() => {
      expect(transferPostCount()).toBe(2);
    });
  });

  it('shows a generic error banner with a working Retry on 504 TIMEOUT (Req 4.10)', async () => {
    const user = userEvent.setup();
    installFetch(() => jsonResponse({ status: 504, error: 'TIMEOUT' }, 504));

    render(<TransferContainer />);
    await fillValidForm(user);
    await submit(user);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'TIMEOUT');
    expect(within(banner).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('blocks submission with no POST when the amount is invalid (Req 5.4)', async () => {
    const user = userEvent.setup();
    installFetch(() => jsonResponse({ status: 201, error: 'COMPLETED' }, 201));

    render(<TransferContainer />);
    // Valid source + destination, but an amount with three decimals.
    await fillValidForm(user, { amount: '1.005' });
    await submit(user);

    // An inline field error is shown and NO transfer POST was issued.
    expect(await screen.findByText(/at most two decimal places/i)).toBeInTheDocument();
    expect(transferPostCount()).toBe(0);
  });

  it('blocks submission with no POST when source equals destination (Req 5.3)', async () => {
    const user = userEvent.setup();
    installFetch(() => jsonResponse({ status: 201, error: 'COMPLETED' }, 201));

    render(<TransferContainer />);
    // Destination identical to the chosen source account.
    await fillValidForm(user, { to: 'ACC-1001' });
    await submit(user);

    expect(
      await screen.findByText(/source and destination accounts must be different/i),
    ).toBeInTheDocument();
    expect(transferPostCount()).toBe(0);
  });

  it('issues exactly one POST when submitted twice while in flight (Req 4.2)', async () => {
    const user = userEvent.setup();
    // The transfer POST never resolves, so the request stays in flight and the
    // in-flight guard must reject the second submit.
    installFetch(() => new Promise<Response>(() => {}));

    render(<TransferContainer />);
    await fillValidForm(user);

    const button = screen.getByRole('button', { name: 'Send transfer' });
    // Two rapid clicks before the (never-resolving) request settles.
    await user.click(button);
    await user.click(button);

    // The guard permits at most one outbound POST per in-flight cycle.
    await waitFor(() => {
      expect(transferPostCount()).toBe(1);
    });
    // The control is disabled while the request is in flight.
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    // Give any erroneously-queued second submit a chance to appear — it must not.
    expect(transferPostCount()).toBe(1);
  });
});
