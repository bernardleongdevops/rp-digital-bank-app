/**
 * NextAuth App Router route handler for the Banking_App.
 *
 * Exposes the OIDC endpoints under `/api/auth/*` (sign-in, callback, session,
 * sign-out, etc.) using the shared `authOptions` from `lib/server/auth.ts`.
 * The same options are reused server-side by `getServerSession` and the BFF
 * `sandboxClient`, keeping a single source of truth for the Auth_Module.
 *
 * The Keycloak callback resolves to the redirect URI
 * `http://localhost:3000/api/auth/callback/keycloak` (via `NEXTAUTH_URL`),
 * which must be registered on the `sandbox-web` client (Requirements 10.3/10.4).
 *
 * NextAuth is constructed lazily, per-request: `getAuthOptions()` calls the
 * fail-fast `getConfig()`, so building the handler at module-evaluation time
 * would force environment validation during the build's page-data collection.
 * Deferring to the first request keeps the route import-safe while preserving
 * fail-fast behaviour at runtime.
 */

import NextAuth from 'next-auth';
import type { NextRequest } from 'next/server';
import { getAuthOptions } from '@/lib/server/auth';

// This route must run on the Node.js runtime and never be statically optimized:
// it depends on request-time server configuration and session state.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: { nextauth: string[] } };

let cachedHandler: ReturnType<typeof NextAuth> | null = null;

/** Build (once) and return the NextAuth request handler. */
function getHandler(): ReturnType<typeof NextAuth> {
  if (cachedHandler === null) {
    cachedHandler = NextAuth(getAuthOptions());
  }
  return cachedHandler;
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  return getHandler()(req, ctx);
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  return getHandler()(req, ctx);
}
