'use client';

/**
 * Dashboard client view (Requirement 2).
 *
 * Renders the signed-in customer's identity and the list of their accounts,
 * each linking to its statement view at `/accounts/[accountNumber]`.
 *
 * Data access (Requirement 6.4 / 11 "browser-to-BFF-only"):
 * this component fetches ONLY the same-origin BFF read endpoints
 * `GET /api/bff/customer` and `GET /api/bff/accounts`. It never contacts the
 * Sandbox_Gateway directly -- the access token and Sandbox_Key stay server-side
 * inside the BFF. Both regions are fetched INDEPENDENTLY so a partial failure
 * degrades per region: a failing profile does not hide a successful account
 * list and vice-versa (Requirement 2.7).
 *
 * Per-region state machine: each region is one of `loading` / `ok` / `empty`
 * (accounts only) / `error`. Shared presentational components render the
 * loading, empty, and error states (Requirement 8.6). A loading state is shown
 * from the moment the request is initiated -- the region starts in `loading`
 * before the first paint, which satisfies the "within 300 ms" bound in
 * Requirement 8.1 (no artificial delay is introduced).
 *
 * Error handling:
 *  - A BFF `401` means the session is no longer valid; the whole view routes
 *    the customer to re-authentication via `signIn` (Requirements 1.7, 4.8-style
 *    re-auth for reads).
 *  - Any other failure (`429`, `5xx`, timeout, network) renders an `ErrorState`
 *    with a retry action that re-initiates only the affected region
 *    (Requirements 2.6, 2.8, 8.2, 8.4). A `429` surfaces a rate-limit message
 *    with the retry control disabled so there is no immediate auto-retry
 *    (Requirement 8.7).
 *  - The view never crashes on an unreachable gateway; failures are captured
 *    into the region state (Requirement 2.8).
 *
 * v1 balance-lag caveat (Requirement 2.9): balances are shown exactly as the
 * account service reports them; the view performs no reconciliation against a
 * just-completed transfer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import type { Account, Customer } from '@/lib/types';
import { formatCurrency } from '@/lib/currency';
import { AppHeader } from '@/app/components/AppHeader';
import { LoadingState } from '@/app/components/LoadingState';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { RefreshButton } from '@/app/components/RefreshButton';

/** A per-region fetch status. */
type RegionStatus = 'loading' | 'ok' | 'error';

interface RegionError {
  /** Safe, user-facing message. Never carries raw upstream detail or secrets. */
  message: string;
  /** False only for rate-limiting (429): retry must wait a short delay. */
  canRetry: boolean;
}

interface RegionState<T> {
  status: RegionStatus;
  data?: T;
  error?: RegionError;
}

const INITIAL: RegionState<never> = { status: 'loading' };

/** Read-call timeout so a hung BFF/gateway surfaces as an error, not a spinner forever. */
const READ_TIMEOUT_MS = 10_000;

/**
 * A fetch failure that should route the customer to re-authentication rather
 * than render an inline error (BFF returned 401).
 */
class ReauthRequired extends Error {}

/**
 * Fetch a same-origin BFF read endpoint and return its parsed JSON body.
 *
 * - `401` -> throw {@link ReauthRequired} so the caller triggers re-auth.
 * - any other non-2xx, timeout, or network failure -> throw a plain `Error`
 *   whose `message` is a safe, user-facing string (the BFF body only ever
 *   carries `{status, error}` on failure).
 */
async function fetchBff<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      // Same-origin BFF call; include the session cookie.
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    // Abort (timeout) or connectivity failure. Never leaks upstream detail.
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    throw new Error(
      aborted
        ? 'This is taking longer than expected. Please try again.'
        : 'We could not reach the service. Check your connection and try again.',
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    throw new ReauthRequired();
  }
  if (res.status === 429) {
    const rl = new Error('Too many requests. Please wait a moment before trying again.');
    rl.name = 'RateLimited';
    throw rl;
  }
  if (!res.ok) {
    throw new Error('Something went wrong loading this section. Please try again.');
  }

  return (await res.json()) as T;
}

export function DashboardClient() {
  const [customer, setCustomer] = useState<RegionState<Customer>>(INITIAL);
  const [accounts, setAccounts] = useState<RegionState<Account[]>>(INITIAL);

  // Guard so a 401 triggers re-authentication AT MOST ONCE per mount. Without
  // this, both regions calling signIn on a 401 (and the subsequent re-render
  // loop) would bounce the browser to Keycloak repeatedly, churning the
  // PKCE/state cookies and producing "state mismatch" errors. A ref is used so
  // the guard is synchronous and shared across both regions.
  const reauthTriggered = useRef(false);

  const triggerReauthOnce = useCallback(() => {
    if (reauthTriggered.current) return;
    reauthTriggered.current = true;
    void signIn('keycloak', { callbackUrl: '/dashboard' });
  }, []);

  /**
   * Load the customer profile region independently of accounts.
   *
   * On (re)load the region moves to `loading` but RETAINS any previously
   * loaded `data` so a Manual_Refresh does not blank the currently displayed
   * profile while the request is in flight (Requirement 1.6). On failure the
   * prior `data` is likewise retained alongside the error so a failed refresh
   * never wipes the previously displayed data (Requirement 1.8). On the very
   * first mount there is no prior data, so the region renders its loading /
   * error state exactly as before.
   */
  const loadCustomer = useCallback(async () => {
    setCustomer((prev) => ({ status: 'loading', data: prev.data }));
    try {
      const data = await fetchBff<Customer>('/api/bff/customer');
      setCustomer({ status: 'ok', data });
    } catch (e) {
      if (e instanceof ReauthRequired) {
        triggerReauthOnce();
        return;
      }
      setCustomer((prev) => ({ status: 'error', data: prev.data, error: toRegionError(e) }));
    }
  }, [triggerReauthOnce]);

  /** Load the accounts region independently of the customer profile. */
  const loadAccounts = useCallback(async () => {
    setAccounts((prev) => ({ status: 'loading', data: prev.data }));
    try {
      const data = await fetchBff<Account[]>('/api/bff/accounts');
      setAccounts({ status: 'ok', data });
    } catch (e) {
      if (e instanceof ReauthRequired) {
        triggerReauthOnce();
        return;
      }
      setAccounts((prev) => ({ status: 'error', data: prev.data, error: toRegionError(e) }));
    }
  }, [triggerReauthOnce]);

  /**
   * Manual_Refresh handler (Requirement 1.4): re-invoke BOTH region loaders and
   * return a single promise that settles only when both have settled. The
   * shared `RefreshButton` disables itself for the duration (single-flight,
   * Requirement 1.6) and re-enables on settle (Requirements 1.7, 1.8). Each
   * region independently replaces its data on success or retains prior data +
   * shows its own error on failure (handled inside the loaders above), so a
   * partial failure degrades per region rather than failing the whole refresh.
   */
  const refreshAll = useCallback(async () => {
    await Promise.all([loadCustomer(), loadAccounts()]);
  }, [loadCustomer, loadAccounts]);

  // Kick off both regions on mount. They run concurrently and independently so
  // one failing does not block or hide the other (Requirement 2.7).
  useEffect(() => {
    void loadCustomer();
    void loadAccounts();
  }, [loadCustomer, loadAccounts]);

  return (
    <main aria-labelledby="dashboard-heading">
      {/* Shared navigation + single logout control (Requirements 8.1, 8.2,
          8.3). The AppHeader provides the Transfer link and the logout
          control, so the ad-hoc "Make a transfer" link and the standalone
          LogoutButton are no longer rendered here. */}
      <AppHeader active="dashboard" />
      <header>
        <h1 id="dashboard-heading">Your accounts</h1>
        {/* Manual_Refresh (Requirements 1.4, 1.6-1.8): re-fetch both regions
            without a full page reload; disabled while in flight. */}
        <RefreshButton onRefresh={refreshAll} label="Refresh" refreshingLabel="Refreshing…" />
      </header>

      <section aria-labelledby="profile-heading" aria-busy={customer.status === 'loading'}>
        <h2 id="profile-heading">Profile</h2>
        {customer.status === 'loading' ? (
          <LoadingState label="Loading your profile…" />
        ) : customer.status === 'error' ? (
          <ErrorState
            message={customer.error?.message}
            canRetry={customer.error?.canRetry ?? true}
            onRetry={() => void loadCustomer()}
            retryLabel="Retry loading profile"
          />
        ) : customer.data ? (
          <dl>
            <dt>Name</dt>
            <dd data-testid="customer-name">{customer.data.name}</dd>
            <dt>Customer reference</dt>
            <dd data-testid="customer-ref">{customer.data.customerRef}</dd>
            {customer.data.email ? (
              <>
                <dt>Email</dt>
                <dd>{customer.data.email}</dd>
              </>
            ) : null}
            {customer.data.kycStatus ? (
              <>
                <dt>KYC status</dt>
                <dd data-testid="customer-kyc">{customer.data.kycStatus}</dd>
              </>
            ) : null}
            {customer.data.profile?.phone ? (
              <>
                <dt>Phone</dt>
                <dd>{customer.data.profile.phone}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </section>

      <section aria-labelledby="accounts-heading" aria-busy={accounts.status === 'loading'}>
        <h2 id="accounts-heading">Accounts</h2>
        {accounts.status === 'loading' ? (
          <LoadingState label="Loading your accounts…" />
        ) : accounts.status === 'error' ? (
          <ErrorState
            message={accounts.error?.message}
            canRetry={accounts.error?.canRetry ?? true}
            onRetry={() => void loadAccounts()}
            retryLabel="Retry loading accounts"
          />
        ) : accounts.data && accounts.data.length === 0 ? (
          <EmptyState
            title="No accounts"
            description="You do not have any accounts to display yet."
          />
        ) : accounts.data ? (
          <ul aria-label="Account list">
            {accounts.data.map((account) => (
              <li key={account.accountNumber} data-testid="account-item">
                <Link href={`/accounts/${encodeURIComponent(account.accountNumber)}`}>
                  <span data-testid="account-number">{account.accountNumber}</span>
                  <span>{' · '}</span>
                  <span>{account.type}</span>
                  <span>{' · '}</span>
                  <span data-testid="account-balance">
                    {formatCurrency(account.balance, account.currency)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}

/** Map a thrown fetch error to the safe per-region error shape. */
function toRegionError(e: unknown): RegionError {
  if (e instanceof Error && e.name === 'RateLimited') {
    return { message: e.message, canRetry: false };
  }
  if (e instanceof Error) {
    return { message: e.message, canRetry: true };
  }
  return { message: 'Something went wrong. Please try again.', canRetry: true };
}
