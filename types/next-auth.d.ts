// TypeScript module augmentation for NextAuth (next-auth v4).
//
// This file extends the library's `Session` and `JWT` shapes so the auth
// callbacks are strongly typed. The split is deliberate and is the core of the
// BFF token-confinement posture (design "Authentication" section):
//
//   - The server-side JWT holds the Keycloak `accessToken` and `expiresAt`.
//     These live ONLY in the encrypted, HTTP-only session cookie / server-side
//     token and are read server-side by the BFF `sandboxClient`.
//   - The client-facing `Session` exposes ONLY non-sensitive fields (a display
//     name and customer reference). It intentionally has NO `accessToken` and
//     NO `expiresAt` property, so there is no typed path to leak the token to
//     the browser.
//
// This module contains no runtime code and no secrets -- it is purely types.

import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  /**
   * The session object returned to the client via `getSession` / `useSession`
   * / the `session` callback. Non-sensitive fields ONLY.
   */
  interface Session {
    user: {
      /** Stable customer reference claim (e.g. "CUST-ALICE"), when present. */
      customerRef?: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  /**
   * The server-side JWT. Holds the Keycloak access token and its absolute
   * expiry so the BFF can attach `Authorization: Bearer <token>` to upstream
   * sandbox calls. NEVER forwarded to the client by the `session` callback.
   */
  interface JWT {
    /** Keycloak access token. Server-only; never exposed to the browser. */
    accessToken?: string;
    /**
     * Keycloak ID token. Server-only; used ONLY as the `id_token_hint` for a
     * clean federated logout at Keycloak's end-session endpoint. Never exposed
     * to the browser by the `session` callback.
     */
    idToken?: string;
    /** Absolute expiry of the access token, epoch seconds. Server-only. */
    expiresAt?: number;
    /** Stable customer reference claim surfaced to the session, if present. */
    customerRef?: string;
    /**
     * Set when the authorization code exchange did not yield a usable access
     * token (failed/cancelled auth). Signals the UI to show a login-failed
     * message and remain unauthenticated (Requirement 1.4).
     */
    error?: 'NoAccessToken';
  }
}
