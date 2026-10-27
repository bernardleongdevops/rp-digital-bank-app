'use client';

/**
 * Statement_View client component (Requirements 3.1-3.8, 8.x).
 *
 * Renders a single owned account's summary and its transaction list, with an
 * optional `from`/`to` date-range filter.
 *
 * Data access discipline (Requirement 6.4 / design "browser-to-BFF-only"):
 *   - The browser ONLY ever calls same-origin BFF endpoints:
 *       GET /api/bff/accounts/[accountNumber]
 *       GET /api/bff/accounts/[accountNumber]/transactions?from=&to=
 *     It NEVER talks to the Sandbox_Gateway directly. The access token and
 *     Sandbox_Key stay server-side in the BFF (Requirement 6.2, 6.3).
 *
 * Fetch strategy: a client component (not a server component) is used so the
 * date-range filter can re-fetch transactions in place, retain previously
 * loaded results on an invalid range (Requirement 3.4), and present distinct
 * loading / empty / error states with a working retry (Requirements 3.6-3.8,
 * 8.x) without a full navigation.
 *
 * Date-range validation (Requirement 3.3, 3.4): the range is validated on the
 * client BEFORE any request is issued. `from > to` shows an inline validation
 * error, does NOT send the request, and retains previously loaded
 * transactions. A valid range (`from <= to`) is forwarded as ISO-8601 query
 * params — mirroring the BFF, which itself returns 400 INVALID_DATE_RANGE for
 * a bad range.
 *
 * Resilience: a LoadingState is shown while a request is in flight (within
 * 300/500 ms since the fetch begins synchronously on mount / submit);
 * EmptyState covers a zero-transaction result; ErrorState (with retry) covers
 * network/timeout/HTTP failures; a 401 routes the customer to re-authentication
 * (Requirement 1.7 / 8.x). The view keeps running on error and never crashes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import type { Account, Transaction } from '@/lib/types';
import { EmptyState } from '@/app/components/EmptyState';
import { ErrorState } from '@/app/components/ErrorState';
import { LoadingState } from '@/app/components/LoadingState';
import { LogoutButton } from '@/app/components/LogoutButton';

export interface StatementClientProps {
  /** The owned account number from the route segment. */
  accountNumber: string;
}

/** A simple async region status for a BFF-backed fetch. */
type Status = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

interface RegionState<T> {
  status: Status;
  data: T | null;
  /** Safe, user-facing error message (never raw upstream detail / secrets). */
  errorMessage?: string;
  /** False only for a 429, where retry must wait for a delay (Requirement 8.7). */
  canRetry: boolean;
  /** Set when a 404 means the account is not owned / not found. */
  notFound?: boolean;
}

function initialRegion<T>(): RegionState<T> {
  return { status: 'idle', data: null, canRetry: true };
}

/** View-level per-request timeout cap (Requirement 8.3). */
const VIEW_TIMEOUT_MS = 15_000;

/**
 * One-shot guard so a 401 triggers re-authentication AT MOST ONCE, even when
 * both the account and transactions regions get a 401 at the same time. Without
 * it, both regions would call `signIn` and bounce the browser to Keycloak
 * repeatedly, churning the PKCE/state cookies and causing "state mismatch"
 * errors. The redirect reloads the page, so this module flag naturally resets.
 */
let reauthInFlight = false;

/**
 * Route the customer to re-authentication on a 401 (Requirement 1.7 / 8.x).
 * Centralised so both regions behave identically; fires only once per load.
 */
function reauthenticate(): void {
  if (reauthInFlight) return;
  reauthInFlight = true;
  void signIn('keycloak', { callbackUrl: window.location.pathname });
}

/**
 * Map a browser-facing BFF error (status + `error` code only) to safe,
 * user-facing copy. The BFF forwards nothing secret, so this only ever sees a
 * numeric status and a machine-readable code.
 */
function messageForStatus(status: number, code: string | undefined): string {
  if (status === 504 || code === 'TIMEOUT') {
    return 'The request timed out. Please try again.';
  }
  if (status === 502 || code === 'NETWORK') {
    return 'We could not reach the bank. Please check your connection and try again.';
  }
  if (status === 429 || code === 'RATE_LIMITED') {
    return 'You have made too many requests. Please wait a moment before retrying.';
  }
  return 'Something went wrong while loading. Please try again.';
}

/**
 * Perform a same-origin BFF GET with a view-level timeout (Requirement 8.3).
 * Returns a normalized shape so callers never touch raw responses. Secrets
 * cannot appear here because the BFF never forwards them.
 */
async function bffGet<T>(
  url: string,
): Promise<
  | { kind: 'ok'; data: T }
  | { kind: 'unauthenticated' }
  | { kind: 'rate-limited' }
  | { kind: 'not-found' }
  | { kind: 'error'; status: number; code?: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIEW_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // Same-origin credentials carry the HTTP-only session cookie; no token
      // is ever read in the browser.
      credentials: 'same-origin',
      signal: controller.signal,
    });

    if (res.ok) {
      const data = (await res.json()) as T;
      return { kind: 'ok', data };
    }

    if (res.status === 401) return { kind: 'unauthenticated' };
    if (res.status === 429) return { kind: 'rate-limited' };
    if (res.status === 404) return { kind: 'not-found' };

    // Read the browser-safe error envelope { status, error } when present.
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      code = body?.error;
    } catch {
      // Non-JSON error body; fall back to the status alone.
    }
    return { kind: 'error', status: res.status, code };
  } catch (e) {
    // AbortError (timeout) and connectivity failures both surface as a generic
    // error region; the message distinguishes timeout from network.
    const isAbort = e instanceof DOMException && e.name === 'AbortError';
    return { kind: 'error', status: isAbort ? 504 : 502, code: isAbort ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

/** Format a numeric balance as a currency value for display (Requirement 3.5). */
function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    // Unknown currency code: fall back to a plain fixed-2 value plus the code.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Format an ISO-8601 timestamp for display; fall back to the raw value. */
function formatTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

export function StatementClient({ accountNumber }: StatementClientProps) {
  const [account, setAccount] = useState<RegionState<Account>>(initialRegion<Account>());
  const [transactions, setTransactions] = useState<RegionState<Transaction[]>>(
    initialRegion<Transaction[]>(),
  );

  // Date-range filter inputs (controlled). `appliedRange` is the range that is
  // currently reflected in the loaded transactions.
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');
  const [rangeError, setRangeError] = useState<string | null>(null);

  // Retain the last successfully loaded transactions across an invalid-range
  // submission (Requirement 3.4): we never clear `transactions.data` on a
  // client-side validation failure.

  // Load the account summary (Requirement 3.1).
  const loadAccount = useCallback(async () => {
    setAccount((prev) => ({ ...prev, status: 'loading', errorMessage: undefined }));
    const res = await bffGet<Account>(
      `/api/bff/accounts/${encodeURIComponent(accountNumber)}`,
    );
    switch (res.kind) {
      case 'ok':
        setAccount({ status: 'ok', data: res.data, canRetry: true });
        return;
      case 'unauthenticated':
        reauthenticate();
        setAccount({
          status: 'error',
          data: null,
          canRetry: true,
          errorMessage: 'Your session has expired. Redirecting you to sign in…',
        });
        return;
      case 'not-found':
        setAccount({
          status: 'error',
          data: null,
          canRetry: false,
          notFound: true,
          errorMessage:
            'This account could not be found, or it is not one of your accounts.',
        });
        return;
      case 'rate-limited':
        setAccount({
          status: 'error',
          data: null,
          canRetry: false,
          errorMessage: messageForStatus(429, 'RATE_LIMITED'),
        });
        return;
      case 'error':
        setAccount({
          status: 'error',
          data: null,
          canRetry: true,
          errorMessage: messageForStatus(res.status, res.code),
        });
        return;
    }
  }, [accountNumber]);

  // Load transactions, optionally with a validated range (Requirement 3.2, 3.3).
  const loadTransactions = useCallback(
    async (range?: { from: string; to: string }) => {
      setTransactions((prev) => ({ ...prev, status: 'loading', errorMessage: undefined }));

      const params = new URLSearchParams();
      if (range) {
        params.set('from', range.from);
        params.set('to', range.to);
      }
      const qs = params.toString();
      const url = `/api/bff/accounts/${encodeURIComponent(accountNumber)}/transactions${
        qs ? `?${qs}` : ''
      }`;

      const res = await bffGet<Transaction[]>(url);
      switch (res.kind) {
        case 'ok': {
          const list = Array.isArray(res.data) ? res.data : [];
          setTransactions({
            status: list.length === 0 ? 'empty' : 'ok',
            data: list,
            canRetry: true,
          });
          return;
        }
        case 'unauthenticated':
          reauthenticate();
          setTransactions((prev) => ({
            ...prev,
            status: 'error',
            canRetry: true,
            errorMessage: 'Your session has expired. Redirecting you to sign in…',
          }));
          return;
        case 'not-found':
          // A 404 on the transactions endpoint means the account is not owned
          // / not found; keep any previously loaded data visible is moot here,
          // but do not crash.
          setTransactions((prev) => ({
            ...prev,
            status: 'error',
            canRetry: false,
            notFound: true,
            errorMessage:
              'This account could not be found, or it is not one of your accounts.',
          }));
          return;
        case 'rate-limited':
          setTransactions((prev) => ({
            ...prev,
            status: 'error',
            canRetry: false,
            errorMessage: messageForStatus(429, 'RATE_LIMITED'),
          }));
          return;
        case 'error':
          // Retain previously loaded data for the view (Requirement 8.4) while
          // surfacing the error.
          setTransactions((prev) => ({
            ...prev,
            status: 'error',
            canRetry: true,
            errorMessage: messageForStatus(res.status, res.code),
          }));
          return;
      }
    },
    [accountNumber],
  );

  // Initial load on mount: account summary + full transaction history run
  // independently so one failing region does not block the other.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    void loadAccount();
    void loadTransactions();
  }, [loadAccount, loadTransactions]);

  // Apply the date-range filter (Requirement 3.3, 3.4). Validation happens
  // here, BEFORE any request is sent.
  const onApplyRange = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      const from = fromInput.trim();
      const to = toInput.trim();

      // Both empty -> clear the filter and load the full history.
      if (from === '' && to === '') {
        setRangeError(null);
        void loadTransactions();
        return;
      }

      // A one-sided range is incomplete; require both bounds for a filter.
      if (from === '' || to === '') {
        setRangeError('Please provide both a start and an end date for the range.');
        return; // No request sent; previously loaded transactions are retained.
      }

      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        setRangeError('Please provide valid start and end dates.');
        return; // No request sent.
      }

      // Reject an inverted range WITHOUT sending a request and retain existing
      // transactions (Requirement 3.4). This mirrors the BFF's
      // 400 INVALID_DATE_RANGE guard.
      if (fromMs > toMs) {
        setRangeError('The start date must be on or before the end date.');
        return;
      }

      // Valid range: forward ISO-8601 values. `datetime-local` inputs yield a
      // value without a timezone; convert to a full ISO-8601 instant so the
      // sandbox receives an unambiguous datetime.
      setRangeError(null);
      void loadTransactions({
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
      });
    },
    [fromInput, toInput, loadTransactions],
  );

  const hasLoadedTransactions = (transactions.data?.length ?? 0) > 0;

  return (
    <main>
      <header>
        <nav aria-label="Primary">
          <a href="/dashboard">Back to dashboard</a>
        </nav>
        <h1>Account statement</h1>
        <LogoutButton />
      </header>

      {/* --- Account summary region (Requirement 3.1, 3.5) --- */}
      <section aria-label="Account summary">
        <h2>Account {accountNumber}</h2>
        {account.status === 'loading' || account.status === 'idle' ? (
          <LoadingState label="Loading account details…" />
        ) : null}

        {account.status === 'ok' && account.data ? (
          <dl>
            <div>
              <dt>Account number</dt>
              <dd>{account.data.accountNumber}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{account.data.type}</dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd>{formatCurrency(account.data.balance, account.data.currency)}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>{account.data.currency}</dd>
            </div>
          </dl>
        ) : null}

        {account.status === 'error' ? (
          <ErrorState
            message={account.errorMessage}
            onRetry={account.notFound ? undefined : () => void loadAccount()}
            canRetry={account.canRetry}
          />
        ) : null}
      </section>

      {/* --- Date-range filter (Requirement 3.3, 3.4) --- */}
      <section aria-label="Filter transactions by date">
        <h2>Filter by date</h2>
        <form onSubmit={onApplyRange} noValidate>
          <div>
            <label htmlFor="statement-from">From</label>
            <input
              id="statement-from"
              name="from"
              type="datetime-local"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              aria-invalid={rangeError ? true : undefined}
              aria-describedby={rangeError ? 'statement-range-error' : undefined}
            />
          </div>
          <div>
            <label htmlFor="statement-to">To</label>
            <input
              id="statement-to"
              name="to"
              type="datetime-local"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
              aria-invalid={rangeError ? true : undefined}
              aria-describedby={rangeError ? 'statement-range-error' : undefined}
            />
          </div>
          {rangeError ? (
            <p id="statement-range-error" role="alert" data-testid="range-error">
              {rangeError}
            </p>
          ) : null}
          <button type="submit">Apply filter</button>
        </form>
      </section>

      {/* --- Transactions region (Requirement 3.2, 3.5-3.8) --- */}
      <section aria-label="Transactions">
        <h2>Transactions</h2>

        {transactions.status === 'loading' || transactions.status === 'idle' ? (
          <LoadingState label="Loading transactions…" />
        ) : null}

        {transactions.status === 'empty' ? (
          <EmptyState
            title="No transactions"
            description="There are no transactions for the selected date range."
          />
        ) : null}

        {transactions.status === 'ok' && hasLoadedTransactions ? (
          <table>
            <caption>Transactions for account {accountNumber}</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Description</th>
                <th scope="col">Direction</th>
                <th scope="col">Amount</th>
                <th scope="col">Running balance</th>
              </tr>
            </thead>
            <tbody>
              {transactions.data?.map((txn) => {
                const currency = account.data?.currency ?? '';
                const signedAmount =
                  txn.direction === 'DEBIT' ? -Math.abs(txn.amount) : Math.abs(txn.amount);
                return (
                  <tr key={txn.id}>
                    <td>{formatTimestamp(txn.timestamp)}</td>
                    <td>{txn.description}</td>
                    <td>{txn.direction}</td>
                    <td data-direction={txn.direction}>
                      {currency ? formatCurrency(signedAmount, currency) : signedAmount.toFixed(2)}
                    </td>
                    <td>
                      {txn.runningBalance !== undefined
                        ? currency
                          ? formatCurrency(txn.runningBalance, currency)
                          : txn.runningBalance.toFixed(2)
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}

        {transactions.status === 'error' ? (
          <ErrorState
            message={transactions.errorMessage}
            onRetry={
              transactions.notFound
                ? undefined
                : () => {
                    // Retry re-runs the currently applied filter. We re-derive
                    // it from the inputs; an empty/invalid input set simply
                    // reloads the full history.
                    const from = fromInput.trim();
                    const to = toInput.trim();
                    const fromMs = Date.parse(from);
                    const toMs = Date.parse(to);
                    if (
                      from !== '' &&
                      to !== '' &&
                      !Number.isNaN(fromMs) &&
                      !Number.isNaN(toMs) &&
                      fromMs <= toMs
                    ) {
                      void loadTransactions({
                        from: new Date(fromMs).toISOString(),
                        to: new Date(toMs).toISOString(),
                      });
                    } else {
                      void loadTransactions();
                    }
                  }
            }
            canRetry={transactions.canRetry}
          />
        ) : null}
      </section>
    </main>
  );
}
