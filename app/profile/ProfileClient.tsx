'use client';

/**
 * Profile_Page client component (Requirement 7.1-7.13, 8.x, 10.x).
 *
 * Renders the signed-in Customer's profile -- the `Customer` identity fields
 * (name, customerRef, email, nationalId, kycStatus) and the nested
 * `CustomerProfile` fields that are present -- fetched from the same-origin BFF
 * read endpoint `GET /api/bff/customer` (Requirement 7.1). The shell page
 * (`app/profile/page.tsx`) already renders the shared `AppHeader`, so this
 * component deliberately does NOT render it again (one AppHeader per page,
 * Requirement 8.2).
 *
 * Data access discipline (Requirement 8.9 / design "browser-to-BFF-only",
 * Property 9): the browser ONLY ever calls same-origin `/api/bff/*` routes --
 * `GET /api/bff/customer` for the read, and (when edits are enabled)
 * `PATCH /api/bff/customer` for the update. It NEVER talks to the
 * Sandbox_Gateway directly; the access token and Sandbox_Key stay server-side
 * in the BFF (Requirements 9.1, 9.2).
 *
 * Resilience (mirrors `AccountDetailsClient`): a LoadingState is shown while the
 * request is in flight -- the region starts in `loading` and the fetch begins
 * synchronously on mount, so the loading state is visible from first paint
 * within 300 ms (Requirement 7.3); an EmptyState covers a "no profile" result
 * (Requirement 7.4); a 401 routes the customer to re-authentication once per
 * mount (Requirement 7.6); a 429 shows a rate-limit message with retry disabled
 * (Requirement 7.7); and a timeout / network / other error shows a generic
 * ErrorState with retry (Requirement 7.5). The view keeps running on error and
 * never crashes.
 *
 * Conditional edit support (Requirements 7.8-7.13): the Sandbox_Gateway's
 * profile-update endpoint (`PATCH /customers/me`) is ASSUMED in the design and
 * not yet confirmed. The {@link EDITS_ENABLED} flag below gates the entire edit
 * code path. While it is `false` the page renders purely read-only with NO edit
 * control (Requirement 7.10). The edit path is implemented behind the flag so
 * it is ready to switch on -- once the backend confirms the endpoint, flip the
 * flag to `true` and the edit form, client-side per-field validation, and the
 * `mapMutationOutcome`-driven success / error-retaining / re-auth handling all
 * activate (Requirements 7.8, 7.9, 7.11, 7.12, 7.13).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import type { Customer, CustomerProfileUpdate } from '@/lib/types';
import { mapMutationOutcome, type MutationPresentation } from '@/lib/transferPresentation';
import { EmptyState } from '@/app/components/EmptyState';
import { ErrorState } from '@/app/components/ErrorState';
import { LoadingState } from '@/app/components/LoadingState';

/**
 * Whether the Sandbox_Gateway supports CustomerProfile edits (Requirement 7.8,
 * 7.10). The backend update endpoint (`PATCH /customers/me`, proxied by
 * `PATCH /api/bff/customer`) is ASSUMED in the design and NOT yet confirmed, so
 * this is `false`: the page renders read-only and presents no edit control
 * (Requirement 7.10). Flip this to `true` once the backend confirms the PATCH
 * endpoint exists; the entire edit code path below is already implemented and
 * gated on this flag, so no other change is required to turn editing on
 * (Requirements 7.8, 7.9, 7.11, 7.12, 7.13).
 */
const EDITS_ENABLED = false;

/** A simple async region status for a BFF-backed fetch. */
type Status = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

interface RegionState<T> {
  status: Status;
  data: T | null;
  /** Safe, user-facing error message (never raw upstream detail / secrets). */
  errorMessage?: string;
  /** False only for a 429, where retry must wait for a delay (Requirement 7.7). */
  canRetry: boolean;
}

function initialRegion<T>(): RegionState<T> {
  return { status: 'idle', data: null, canRetry: true };
}

/** View-level per-request timeout cap (Requirement 7.5 / 10.4: 10 seconds). */
const VIEW_TIMEOUT_MS = 10_000;

/** The editable CustomerProfile fields the edit form exposes (Requirement 7.8). */
const EDITABLE_FIELDS = [
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'postalCode',
  'country',
  'occupation',
  'preferredChannel',
] as const satisfies readonly (keyof CustomerProfileUpdate)[];

type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Human-readable labels for the identity and profile fields rendered in the <dl>. */
const PROFILE_FIELD_LABELS: Record<EditableField, string> = {
  phone: 'Phone',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  city: 'City',
  postalCode: 'Postal code',
  country: 'Country',
  occupation: 'Occupation',
  preferredChannel: 'Preferred channel',
};

/**
 * One-shot guard so a 401 triggers re-authentication AT MOST ONCE per mount
 * (Requirements 7.6, 7.13). Mirrors the guard in `AccountDetailsClient`:
 * without it a re-render could call `signIn` repeatedly, churning the
 * PKCE/state cookies and causing "state mismatch" errors. The redirect reloads
 * the page, so this module flag naturally resets.
 */
let reauthInFlight = false;

/**
 * Route the customer to re-authentication on a 401 (Requirements 7.6, 7.13).
 * Fires only once per load; the callback returns the customer to this view.
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
 * Perform a same-origin BFF GET with a view-level timeout (Requirement 7.5).
 * Returns a normalized shape so callers never touch raw responses. Secrets
 * cannot appear here because the BFF never forwards them. Mirrors the
 * `bffGet` helper in `AccountDetailsClient`.
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

/**
 * Perform a same-origin BFF PATCH with a view-level timeout, used by the gated
 * edit path (Requirement 7.8). Returns the browser-facing `{ status, error? }`
 * so the caller can feed it to {@link mapMutationOutcome}. AbortError / network
 * failures project onto the same 504/502 the BFF would use so the mutation
 * mapper routes them to the generic retryable error (Requirement 7.12).
 */
async function bffPatch(
  url: string,
  body: CustomerProfileUpdate,
): Promise<{ status: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIEW_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    let code: string | undefined;
    try {
      const parsed = (await res.json()) as { error?: string };
      code = parsed?.error;
    } catch {
      // No / non-JSON body; the status alone drives the outcome.
    }
    return { status: res.status, error: code };
  } catch (e) {
    const isAbort = e instanceof DOMException && e.name === 'AbortError';
    return { status: isAbort ? 504 : 502, error: isAbort ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

export function ProfileClient() {
  const [profile, setProfile] = useState<RegionState<Customer>>(initialRegion<Customer>());

  // Load the CustomerProfile (Requirements 7.1, 7.2). On (re)load the region
  // moves to `loading` but RETAINS any previously loaded data so a retry never
  // blanks the currently displayed profile (Requirement 7.5).
  const loadProfile = useCallback(async () => {
    setProfile((prev) => ({ ...prev, status: 'loading', errorMessage: undefined }));
    const res = await bffGet<Customer | null>('/api/bff/customer');
    switch (res.kind) {
      case 'ok':
        // A successful response with no customer surfaces the empty state
        // "profile unavailable" and shows NO field values (Requirement 7.4).
        if (res.data === null || res.data === undefined) {
          setProfile({ status: 'empty', data: null, canRetry: true });
          return;
        }
        setProfile({ status: 'ok', data: res.data, canRetry: true });
        return;
      case 'unauthenticated':
        // Treat the customer as unauthenticated and route to re-authentication
        // (Requirement 7.6).
        reauthenticate();
        setProfile((prev) => ({
          status: 'error',
          data: prev.data,
          canRetry: true,
          errorMessage: 'Your session has expired. Redirecting you to sign in…',
        }));
        return;
      case 'not-found':
        // No profile for the customer: profile unavailable (Requirement 7.4).
        setProfile({ status: 'empty', data: null, canRetry: true });
        return;
      case 'rate-limited':
        // Rate-limit message with retry disabled; no automatic retry before a
        // delay of at least 60 seconds (Requirement 7.7).
        setProfile((prev) => ({
          status: 'error',
          data: prev.data,
          canRetry: false,
          errorMessage: messageForStatus(429, 'RATE_LIMITED'),
        }));
        return;
      case 'error':
        // Timeout / network / any other status: generic error with retry; the
        // view keeps running and never crashes (Requirement 7.5).
        setProfile((prev) => ({
          status: 'error',
          data: prev.data,
          canRetry: true,
          errorMessage: messageForStatus(res.status, res.code),
        }));
        return;
    }
  }, []);

  // Initial load on mount. The fetch begins synchronously here so the loading
  // state is visible from first paint (Requirement 7.3), with no artificial
  // delay.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    void loadProfile();
  }, [loadProfile]);

  return (
    <main aria-labelledby="profile-heading">
      <h1 id="profile-heading">Your profile</h1>

      <section aria-label="Profile details" aria-busy={profile.status === 'loading'}>
        {profile.status === 'loading' || profile.status === 'idle' ? (
          <LoadingState label="Loading your profile…" />
        ) : null}

        {profile.status === 'empty' ? (
          <EmptyState
            title="Profile unavailable"
            description="Your profile could not be found, or it is not available right now."
          />
        ) : null}

        {profile.status === 'ok' && profile.data ? (
          <ProfileView
            customer={profile.data}
            onUpdated={(updated) =>
              setProfile({ status: 'ok', data: updated, canRetry: true })
            }
          />
        ) : null}

        {profile.status === 'error' ? (
          <ErrorState
            message={profile.errorMessage}
            onRetry={() => void loadProfile()}
            canRetry={profile.canRetry}
            retryLabel="Retry loading profile"
          />
        ) : null}
      </section>
    </main>
  );
}

/**
 * Renders the loaded CustomerProfile as a read-only <dl> (Requirements 7.2,
 * 7.10). When {@link EDITS_ENABLED} is `true` it additionally mounts the gated
 * {@link ProfileEditForm}; while the flag is `false` NO edit control is
 * rendered, keeping the page strictly read-only (Requirement 7.10).
 */
function ProfileView({
  customer,
  onUpdated,
}: {
  customer: Customer;
  onUpdated: (updated: Customer) => void;
}) {
  const p = customer.profile;
  return (
    <>
      <dl>
        <div>
          <dt>Name</dt>
          <dd data-testid="profile-name">{customer.name}</dd>
        </div>
        <div>
          <dt>Customer reference</dt>
          <dd data-testid="profile-customer-ref">{customer.customerRef}</dd>
        </div>
        {customer.email ? (
          <div>
            <dt>Email</dt>
            <dd data-testid="profile-email">{customer.email}</dd>
          </div>
        ) : null}
        {customer.nationalId ? (
          <div>
            <dt>National ID</dt>
            <dd data-testid="profile-national-id">{customer.nationalId}</dd>
          </div>
        ) : null}
        {customer.kycStatus ? (
          <div>
            <dt>KYC status</dt>
            <dd data-testid="profile-kyc">{customer.kycStatus}</dd>
          </div>
        ) : null}

        {/* Nested CustomerProfile.* fields, each rendered only when present
            (Requirement 7.2). `dateOfBirth` is a read-only identity field (not
            in the editable set) and is shown when present. */}
        {p?.dateOfBirth ? (
          <div>
            <dt>Date of birth</dt>
            <dd data-testid="profile-date-of-birth">{p.dateOfBirth}</dd>
          </div>
        ) : null}
        {EDITABLE_FIELDS.map((field) => {
          const value = p?.[field];
          if (typeof value !== 'string' || value.length === 0) return null;
          return (
            <div key={field}>
              <dt>{PROFILE_FIELD_LABELS[field]}</dt>
              <dd data-testid={`profile-${field}`}>{value}</dd>
            </div>
          );
        })}
      </dl>

      {/* Conditional edit control (Requirement 7.8-7.13). Gated on
          EDITS_ENABLED: while the backend PATCH endpoint is unconfirmed the
          flag is false and NO edit control renders (Requirement 7.10). */}
      {EDITS_ENABLED ? <ProfileEditForm customer={customer} onUpdated={onUpdated} /> : null}
    </>
  );
}

/**
 * The gated profile edit form (Requirements 7.8, 7.9, 7.11, 7.12, 7.13).
 *
 * This component is only mounted when {@link EDITS_ENABLED} is `true`. It is
 * implemented now so the edit capability is ready the moment the backend
 * confirms `PATCH /customers/me`; while the flag is `false` it is inert (never
 * rendered). It:
 *   - presents an input per editable `CustomerProfileUpdate` field (Req 7.8);
 *   - client-validates each editable field is a string before submitting --
 *     any invalid field shows a field-level error and NO request is sent
 *     (Requirement 7.9);
 *   - on submit PATCHes `/api/bff/customer` and maps the outcome via
 *     {@link mapMutationOutcome}: success shows a success state and the updated
 *     fields (Requirement 7.11); an error retains the previously displayed
 *     fields (Requirement 7.12); a 401 routes to re-authentication
 *     (Requirement 7.13).
 */
function ProfileEditForm({
  customer,
  onUpdated,
}: {
  customer: Customer;
  onUpdated: (updated: Customer) => void;
}) {
  // Seed each editable field from the current profile (empty string when absent).
  const [values, setValues] = useState<Record<EditableField, string>>(() => {
    const seed = {} as Record<EditableField, string>;
    for (const field of EDITABLE_FIELDS) {
      const current = customer.profile?.[field];
      seed[field] = typeof current === 'string' ? current : '';
    }
    return seed;
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<EditableField, string>>>({});
  const [outcome, setOutcome] = useState<MutationPresentation | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setField = useCallback((field: EditableField, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
  }, []);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (submitting) return;

      // Client-side validation: every editable field value must be a string
      // (Requirement 7.9). Controlled inputs always yield strings, but validate
      // explicitly so an invalid field blocks the request with a field error
      // and NO request is sent.
      const nextErrors: Partial<Record<EditableField, string>> = {};
      const update: CustomerProfileUpdate = {};
      for (const field of EDITABLE_FIELDS) {
        const value = values[field];
        if (typeof value !== 'string') {
          nextErrors[field] = 'This field must be text.';
          continue;
        }
        // Only include fields the customer actually set a value for.
        if (value.length > 0) {
          update[field] = value;
        }
      }
      if (Object.keys(nextErrors).length > 0) {
        setFieldErrors(nextErrors);
        return; // Do NOT send the request (Requirement 7.9).
      }
      setFieldErrors({});

      setSubmitting(true);
      const res = await bffPatch('/api/bff/customer', update);
      setSubmitting(false);

      const presentation = mapMutationOutcome(res);
      if (presentation.requiresReauth) {
        // 401: treat as unauthenticated and route to re-authentication
        // (Requirement 7.13).
        reauthenticate();
        setOutcome(presentation);
        return;
      }
      setOutcome(presentation);
      if (presentation.isSuccess) {
        // Success: show success state and the updated fields (Requirement 7.11).
        onUpdated({ ...customer, profile: { ...customer.profile, ...update } });
      }
      // On any non-success outcome the parent's displayed fields are untouched,
      // so the previously displayed profile is retained (Requirement 7.12).
    },
    [customer, onUpdated, submitting, values],
  );

  return (
    <form onSubmit={onSubmit} aria-label="Edit profile" noValidate>
      <h2>Edit profile</h2>

      {outcome ? (
        <div role={outcome.severity === 'error' ? 'alert' : 'status'} data-testid="edit-outcome">
          <p>
            <strong>{outcome.title}</strong>
          </p>
          <p>{outcome.message}</p>
        </div>
      ) : null}

      {EDITABLE_FIELDS.map((field) => {
        const errorId = `profile-edit-${field}-error`;
        const hasError = Boolean(fieldErrors[field]);
        return (
          <div key={field}>
            <label htmlFor={`profile-edit-${field}`}>{PROFILE_FIELD_LABELS[field]}</label>
            <input
              id={`profile-edit-${field}`}
              name={field}
              type="text"
              value={values[field]}
              onChange={(e) => setField(field, e.target.value)}
              aria-invalid={hasError}
              aria-describedby={hasError ? errorId : undefined}
            />
            {hasError ? (
              <p id={errorId} role="alert" data-testid={`profile-edit-${field}-error`}>
                {fieldErrors[field]}
              </p>
            ) : null}
          </div>
        );
      })}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}
