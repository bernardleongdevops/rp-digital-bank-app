/**
 * Route-protection middleware for the Banking_App (Requirement 1.6).
 *
 * Protects the authenticated areas of the app -- `/dashboard`, `/accounts/*`,
 * `/transfer`, `/profile/*`, and `/scheduled-transfers/*` -- by requiring a
 * valid NextAuth session. Any request for one
 * of these views that arrives without an authenticated session is redirected to
 * the `/login` entry point BEFORE the protected route (and therefore any
 * protected data) is rendered, so protected data is never exposed to an
 * unauthenticated caller.
 *
 * Implementation notes:
 *  - Built on next-auth's `withAuth`, which runs on the Edge runtime and reads
 *    the encrypted session token from the request cookies. It does NOT expose
 *    the Keycloak access token to this layer -- the `authorized` callback only
 *    sees the decoded JWT, and a session is treated as valid only when a token
 *    is present AND it carries no `NoAccessToken` error (a failed/cancelled
 *    auth leaves that marker; see `lib/server/auth.ts`).
 *  - `pages.signIn` is set to `/login` so unauthorized requests redirect there,
 *    consistent with the shared auth config.
 *  - The `matcher` scopes the middleware to exactly the protected view trees so
 *    public routes (`/`, `/login`, `/api/auth/*`, static assets) are untouched.
 */

import { withAuth } from 'next-auth/middleware';

export default withAuth({
  pages: {
    // Unauthenticated requests for protected views are redirected here. The
    // callbackUrl is appended by next-auth so the user returns to the
    // originally requested view after a successful sign-in.
    signIn: '/login',
  },
  callbacks: {
    /**
     * A request is authorized only when a decoded session token exists and the
     * authorization code exchange yielded a usable access token (no
     * `NoAccessToken` marker). Returning `false` triggers the redirect to
     * `/login` without rendering the protected route.
     */
    authorized({ token }) {
      return Boolean(token) && token?.error !== 'NoAccessToken';
    },
  },
});

/**
 * Scope the middleware to the protected view trees only (Requirement 1.6):
 *   - `/dashboard`
 *   - `/accounts` and everything beneath it (`/accounts/ACC-1001`,
 *     `/accounts/open`, `/accounts/ACC-1001/details`, ...)
 *   - `/transfer`
 *   - `/profile` and everything beneath it (the Profile_Page)
 *   - `/scheduled-transfers` and everything beneath it (the Scheduled_Transfer
 *     views)
 *
 * The `/profile` and `/scheduled-transfers` trees are authenticated
 * destinations linked from the shared AppHeader, so they are protected here
 * alongside the original trees; `/accounts/open` is already covered by the
 * existing `/accounts/:path*` entry.
 *
 * Everything else (the public landing page, `/login`, the NextAuth API routes,
 * and static assets) is intentionally excluded.
 */
export const config = {
  matcher: [
    '/dashboard/:path*',
    '/accounts/:path*',
    '/transfer/:path*',
    '/profile/:path*',
    '/scheduled-transfers/:path*',
  ],
};
