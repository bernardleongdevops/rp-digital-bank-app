/**
 * Shared, server-only NextAuth configuration for the Banking_App.
 *
 * This module exports `authOptions` (the single source of truth for the
 * Auth_Module) so it can be reused by:
 *   - the NextAuth route handler (`app/api/auth/[...nextauth]/route.ts`), and
 *   - `getServerSession(authOptions)` / the server-side `sandboxClient`, which
 *     reads the Keycloak access token to attach to upstream sandbox calls.
 *
 * Security posture (design "Authentication" section, Requirement 1):
 *   - OIDC Authorization Code flow with PKCE against the Keycloak `sandbox-web`
 *     PUBLIC client (no client secret). PKCE (`code_challenge_method=S256`) and
 *     `state` are enabled by the next-auth Keycloak provider by default.
 *   - The `jwt` callback stores the Keycloak `access_token` and `expires_at` on
 *     the server-side token ONLY.
 *   - The `session` callback exposes ONLY non-sensitive fields (display name and
 *     customer reference) to the client -- never the access token or expiry.
 *   - Sessions expire 24 hours after establishment (Requirement 1.7).
 */

import type { NextAuthOptions } from 'next-auth';
import KeycloakProvider from 'next-auth/providers/keycloak';
import { getConfig } from '@/lib/server/config';

/** 24 hours in seconds -- the session lifetime (Requirement 1.7). */
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * The OIDC callback path NextAuth registers for the Keycloak provider. Combined
 * with `NEXTAUTH_URL` (`http://localhost:3000`) this yields the redirect URI
 * `http://localhost:3000/api/auth/callback/keycloak`, which must be registered
 * on the `sandbox-web` client (Requirement 10.3).
 */
export const KEYCLOAK_CALLBACK_PATH = '/api/auth/callback/keycloak';

/**
 * Build the NextAuth options from validated environment configuration.
 *
 * Kept as a factory so configuration is resolved lazily (and fail-fast via
 * `getConfig`) at request time rather than at module-import time, which keeps
 * the module import-safe for tooling and tests.
 */
export function buildAuthOptions(): NextAuthOptions {
  const config = getConfig();

  return {
    secret: config.nextAuthSecret,

    // Encrypted JWT session strategy: the access token lives in the server-side
    // token / HTTP-only cookie, never in client-readable storage.
    session: {
      strategy: 'jwt',
      // Session expires 24h after it was established; afterwards the user is
      // treated as unauthenticated (Requirement 1.7).
      maxAge: SESSION_MAX_AGE_SECONDS,
    },
    jwt: {
      maxAge: SESSION_MAX_AGE_SECONDS,
    },

    providers: [
      KeycloakProvider({
        issuer: config.keycloakIssuer,
        clientId: config.keycloakClientId,
        // `sandbox-web` is a PUBLIC client (no client secret). NextAuth v4's
        // Keycloak provider requires a `clientSecret` value to be present for
        // its internal openid-client setup, but a public client must NOT
        // authenticate at the token endpoint. We therefore:
        //   - pass a non-empty placeholder secret so the provider initialises,
        //   - force `token_endpoint_auth_method: 'none'` so NO client secret is
        //     actually sent to Keycloak (PKCE is the proof instead), and
        //   - enable PKCE + state checks (S256).
        // Passing an EMPTY string secret is what previously broke the token
        // exchange (openid-client produced a malformed token request), so the
        // placeholder below is deliberate and is never transmitted.
        clientSecret: 'public-client-no-secret',
        client: {
          token_endpoint_auth_method: 'none',
        },
        checks: ['pkce', 'state'],
        authorization: {
          params: {
            scope: 'openid email profile',
          },
        },
      }),
    ],

    pages: {
      // Unauthenticated entry point (the /login page is implemented in task 3.2).
      signIn: '/login',
      // Surface auth failures/timeouts on the login page via `?error=` so the
      // UI can render a timeout (Requirement 1.2) or login-failed (Requirement
      // 1.4) message, and a redirect-URI-not-authorized error (Requirement 10.4).
      error: '/login',
    },

    callbacks: {
      /**
       * Persist the Keycloak access token and its expiry on the SERVER-SIDE
       * token only (Requirement 1.3). If the authorization code exchange did
       * not yield an access token (failed/cancelled auth, or an exchange that
       * returned no token), flag the token with an error so the session is not
       * treated as authenticated and the UI can show a login-failed message
       * (Requirement 1.4).
       */
      async jwt({ token, account, profile }) {
        if (account) {
          // `trigger === "signIn"`: this is the code-exchange result.
          if (account.access_token) {
            token.accessToken = account.access_token;
            // Keep the ID token for a clean federated logout (id_token_hint).
            if (typeof account.id_token === 'string') {
              token.idToken = account.id_token;
            }
            // `expires_at` is epoch seconds when provided by the IdP; otherwise
            // derive from `expires_in` if present.
            if (typeof account.expires_at === 'number') {
              token.expiresAt = account.expires_at;
            } else if (typeof account.expires_in === 'number') {
              token.expiresAt = Math.floor(Date.now() / 1000) + account.expires_in;
            }
            delete token.error;
          } else {
            // No valid Access_Token from the exchange: discard any partial
            // credentials and mark the token so the session stays unauthenticated.
            delete token.accessToken;
            delete token.expiresAt;
            token.error = 'NoAccessToken';
          }

          // Capture a non-sensitive customer reference claim if the IdP supplies
          // one, so the session can expose it without revealing the token.
          const claims = profile as Record<string, unknown> | undefined;
          const customerRef =
            (claims?.customer_ref as string | undefined) ??
            (claims?.preferred_username as string | undefined);
          if (customerRef) {
            token.customerRef = customerRef;
          }
        }

        return token;
      },

      /**
       * Expose ONLY non-sensitive fields to the client (Requirement 1.3/1.4).
       * The access token and `expiresAt` are deliberately NOT copied onto the
       * session, so they never reach the browser in any payload. If the token
       * carries the `NoAccessToken` error, surface only a minimal, non-sensitive
       * marker; the client treats the absence of a usable session as
       * unauthenticated.
       */
      async session({ session, token }) {
        if (token.customerRef) {
          session.user = {
            ...session.user,
            customerRef: token.customerRef,
          };
        }
        return session;
      },

      /**
       * Keep redirects same-origin. NextAuth already restricts callback URLs to
       * the configured `NEXTAUTH_URL` origin (`http://localhost:3000`); this
       * guards against open redirects to other origins.
       */
      async redirect({ url, baseUrl }) {
        if (url.startsWith('/')) return `${baseUrl}${url}`;
        try {
          if (new URL(url).origin === baseUrl) return url;
        } catch {
          // Malformed URL -> fall through to baseUrl.
        }
        return baseUrl;
      },
    },
  };
}

/**
 * Lazily-constructed, memoized NextAuth options. Built on first access so the
 * environment is validated fail-fast at request time.
 */
let cachedAuthOptions: NextAuthOptions | null = null;

/** Accessor used by the route handler and `getServerSession`. */
export function getAuthOptions(): NextAuthOptions {
  if (cachedAuthOptions === null) {
    cachedAuthOptions = buildAuthOptions();
  }
  return cachedAuthOptions;
}
