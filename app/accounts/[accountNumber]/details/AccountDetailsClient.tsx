'use client';

/**
 * Account_Details_View client component (Requirement 2.1-2.9, 8.x, 10.x).
 *
 * Renders a single owned account's details -- account number, type,
 * Account_Status, currency, and balance -- READ-ONLY. There is deliberately no
 * control in this view that mutates the account (Requirement 2.8); the
 * close-account affordance is wired in separately (task 6.2 / CloseAccountButton)
 * and is not part of this view.
 *
 * Data access discipline (Requirement 8.9 / design "browser-to-BFF-only",
 * Property 9):
 *   - The browser ONLY ever calls the same-origin BFF endpoint:
 *       GET /api/bff/accounts/[accountNumber]
 *     It NEVER talks to the Sandbox_Gateway directly. The access token and
 *     Sandbox_Key stay server-side in the BFF (Requirement 9.1, 9.2).
 *
 * Fetch strategy: a client component (not a server component) is used so the
 * view can present distinct loading / empty / not-owner / rate-limit / error
 * states with a working retry (Requirements 2.3-2.9, 10.x) and re-fetch in
 * place without a full navigation.
 *
 * Resilience (mirrors `StatementClient`): a LoadingState is shown while the
 * request is in flight (within 300 ms since the fetch begins synchronously on
 * mount, Requirement 2.3); an EmptyState covers a "no account" result
 * (Requirement 2.4); a distinct not-owner state covers a 403 (Requirement 2.6);
 * a 401 routes the customer to re-authentication once per mount (Requirement
 * 2.7); a 429 shows a rate-limit message with retry disabled (Requirement 2.9);
 * and a timeout / network / other error shows a generic ErrorState with retry
 * (Requirement 2.5). The view keeps running on error and never crashes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import type { Account } from '@/lib/types';
import { formatCurrency } from '@/lib/currency';
import { AppHeader } from '@/app/components/AppHeader';
import { EmptyState } from '@/app/components/EmptyState';
import { ErrorState } from '@/app/components/ErrorState';
import { LoadingState } from '@/app/components/LoadingState';
import { CloseAccountButton } from './CloseAccountButton';

export interface AccountDetailsClientProps {
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
  /** False only for a 429, where retry must wait for a delay (Requirement 2.9). */
  canRetry: boolean;
  /** Set when a 403 means the customer is not the owner of the account. */
  notOwner?: boolean;
}

function initialRegion<T>(): RegionState<T> {
  return { status: 'idle', data: null, canRetry: true };
}

/** View-level per-request timeout cap (Requirement 2.5 / 10.4: 10 seconds). */
const VIEW_TIMEOUT_MS = 10_000;

/**
 * One-shot guard so a 401 triggers re-authentication AT MOST ONCE per mount
 * (Requirement 2.7). Mirrors the guard in `StatementClient`: without it a
 * re-render could call `signIn` repeatedly, churning the PKCE/state cookies and
 * causing "state mismatch" errors. The redirect reloads the page, so this
 * module flag naturally resets.
 */
let reauthInFlight = false;

/**
 * Route the customer to re-authentication on a 401 (Requirement 2.7). Fires
 * only once per load; the callback returns the customer to this same view.
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
 * Perform a same-origin BFF GET with a view-level timeout (Requirement 2.5).
 * Returns a normalized shape so callers never touch raw responses. Secrets
 * cannot appear here because the BFF never forwards them.
 */
async function bffGet<T>(
  url: string,
): Promise<
  | { kind: 'ok'; data: T }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
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
    if (res.status === 403) return { kind: 'forbidden' };
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

export function AccountDetailsClient({ accountNumber }: AccountDetailsClientProps) {
  const [account, setAccount] = useState<RegionState<Account>>(initialRegion<Account>());

  // Load the account details (Requirement 2.1, 2.2).
  const loadAccount = useCallback(async () => {
    setAccount((prev) => ({ ...prev, status: 'loading', errorMessage: undefined }));
    const res = await bffGet<Account | null>(
      `/api/bff/accounts/${encodeURIComponent(accountNumber)}`,
    );
    switch (res.kind) {
      case 'ok':
        // A successful response with no account surfaces the empty state
        // "account unavailable" and shows NO account field values
        // (Requirement 2.4).
        if (res.data === null || res.data === undefined) {
          setAccount({ status: 'empty', data: null, canRetry: true });
          return;
        }
        setAccount({ status: 'ok', data: res.data, canRetry: true });
        return;
      case 'unauthenticated':
        // Treat the customer as unauthenticated and route to re-authentication
        // (Requirement 2.7).
        reauthenticate();
        setAccount({
          status: 'error',
          data: null,
          canRetry: true,
          errorMessage: 'Your session has expired. Redirecting you to sign in…',
        });
        return;
      case 'forbidden':
        // Distinct "not the owner of this account" state (Requirement 2.6).
        setAccount({
          status: 'error',
          data: null,
          canRetry: false,
          notOwner: true,
          errorMessage: 'You are not the owner of this account.',
        });
        return;
      case 'not-found':
        // No account for the requested number: the account is unavailable
        // (Requirement 2.4). Render the empty state with no field values.
        setAccount({ status: 'empty', data: null, canRetry: true });
        return;
      case 'rate-limited':
        // Rate-limit message with retry disabled; no automatic retry before a
        // delay of at least 60 seconds (Requirement 2.9).
        setAccount({
          status: 'error',
          data: null,
          canRetry: false,
          errorMessage: messageForStatus(429, 'RATE_LIMITED'),
        });
        return;
      case 'error':
        // Timeout / network / any other status: generic error with retry; the
        // view keeps running and never crashes (Requirement 2.5).
        setAccount({
          status: 'error',
          data: null,
          canRetry: true,
          errorMessage: messageForStatus(res.status, res.code),
        });
        return;
    }
  }, [accountNumber]);

  // Initial load on mount. The fetch begins synchronously here so the loading
  // state is visible from first paint (Requirement 2.3), with no artificial
  // delay.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    void loadAccount();
  }, [loadAccount]);

  return (
    <main aria-labelledby="account-details-heading">
      <AppHeader active="accounts" />

      <h1 id="account-details-heading">Account details</h1>

      {/* --- Account details region (read-only, Requirement 2.2, 2.8) --- */}
      <section aria-label="Account details" aria-busy={account.status === 'loading'}>
        {account.status === 'loading' || account.status === 'idle' ? (
          <LoadingState label="Loading account details…" />
        ) : null}

        {account.status === 'empty' ? (
          <EmptyState
            title="Account unavailable"
            description="This account could not be found, or it is not available."
          />
        ) : null}

        {account.status === 'ok' && account.data ? (
          <dl>
            <div>
              <dt>Account number</dt>
              <dd data-testid="account-number">{account.data.accountNumber}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd data-testid="account-type">{account.data.type}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd data-testid="account-status">{account.data.status ?? '—'}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd data-testid="account-currency">{account.data.currency}</dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd data-testid="account-balance">
                {formatCurrency(account.data.balance, account.data.currency)}
              </dd>
            </div>
          </dl>
        ) : null}

        {account.status === 'error' && account.notOwner ? (
          // Distinct not-owner state (Requirement 2.6): no retry affordance,
          // since retrying cannot change ownership.
          <div role="alert" data-testid="not-owner">
            <p>{account.errorMessage}</p>
          </div>
        ) : null}

        {account.status === 'error' && !account.notOwner ? (
          <ErrorState
            message={account.errorMessage}
            onRetry={() => void loadAccount()}
            canRetry={account.canRetry}
          />
        ) : null}
      </section>

      {/*
        --- Manage account (Account_Management affordance, Requirement 3) ---
        The read-only detail <dl> above never mutates the account (Requirement
        2.8). Closing an account is a DISTINCT, explicit, separately-confirmed
        control rendered outside that read-only region, which is the intended
        Account_Management affordance (Requirement 3.4-3.12). It is shown only
        when an account has loaded successfully AND is not already closed, so a
        CLOSED account offers no close control.
      */}
      {account.status === 'ok' && account.data && account.data.status !== 'CLOSED' ? (
        <section aria-label="Manage account">
          <h2>Manage account</h2>
          <CloseAccountButton
            accountNumber={accountNumber}
            onClosed={() => void loadAccount()}
          />
        </section>
      ) : null}
    </main>
  );
}
