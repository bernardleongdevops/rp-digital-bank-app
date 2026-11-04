'use client';

/**
 * Client content for the `/login` entry point (Requirements 1.1, 1.2, 1.4, 10.4).
 *
 * Responsibilities:
 *  - Provide the "Sign in with the bank" action that starts the OIDC
 *    Authorization Code + PKCE flow by calling `signIn('keycloak')`. NextAuth
 *    builds the redirect URI from `NEXTAUTH_URL`
 *    (`http://localhost:3000/api/auth/callback/keycloak`), which is the URI
 *    registered on the `sandbox-web` client (Requirement 10.3).
 *  - Surface non-sensitive error/timeout messages driven by the `?error=` query
 *    param that NextAuth appends when it redirects back to the configured error
 *    page (`pages.error = '/login'`). We map only to generic, non-sensitive
 *    copy -- no token, code, or provider detail is ever shown.
 *
 * Error mapping:
 *  - A 300-second login that never completes surfaces as a verification/timeout
 *    error -> timeout message (Requirement 1.2).
 *  - A failed/cancelled auth, or a code exchange yielding no Access_Token,
 *    surfaces as an OAuth callback/sign-in error -> login-failed message
 *    (Requirement 1.4).
 *  - A redirect URI that is not authorized on the `sandbox-web` client surfaces
 *    as a configuration/redirect error -> redirect-URI-not-authorized message
 *    (Requirement 10.4).
 */

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';

/**
 * Non-sensitive, user-facing messages keyed by the NextAuth `error` code. Only
 * generic copy is shown; no credentials or provider internals are surfaced.
 */
function messageForError(error: string | null): string | null {
  if (!error) return null;

  switch (error) {
    // NextAuth surfaces a verification/timeout condition here when the sign-in
    // flow does not complete in time (Requirement 1.2).
    case 'Verification':
    case 'SessionRequired':
      return 'Your login attempt timed out. Please try signing in again.';

    // Redirect URI / provider configuration problems, e.g. the redirect URI is
    // not registered/authorized on the sandbox-web client (Requirement 10.4).
    case 'Configuration':
    case 'RedirectUriMismatch':
      return 'Sign-in is not available because the redirect address is not authorized. Please contact support.';

    // Failed, cancelled, or token-less sign-in / callback (Requirement 1.4).
    case 'OAuthSignin':
    case 'OAuthCallback':
    case 'OAuthCreateAccount':
    case 'Callback':
    case 'AccessDenied':
    case 'NoAccessToken':
    case 'CredentialsSignin':
    case 'Default':
    default:
      return 'Login did not succeed. Please try signing in again.';
  }
}

export function LoginClient() {
  const searchParams = useSearchParams();
  const errorCode = searchParams.get('error');
  const errorMessage = messageForError(errorCode);

  // Preserve the originally requested protected view, if the middleware
  // appended one, so a successful sign-in returns the user there.
  const callbackUrl = searchParams.get('callbackUrl') ?? '/dashboard';

  return (
    <main>
      <h1>FiNova Digital Bank</h1>
      <section>
        <h2>Sign in</h2>
        <p role="note" style={{ color: 'var(--muted)', marginBottom: '16px' }}>
          Access your accounts, statements, and transfers.
        </p>

        {errorMessage ? (
          <p role="alert" data-testid="login-error" style={{ marginBottom: '16px' }}>
            {errorMessage}
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => {
            void signIn('keycloak', { callbackUrl });
          }}
        >
          Sign in with the bank
        </button>
      </section>
    </main>
  );
}
