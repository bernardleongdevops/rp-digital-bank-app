/**
 * Root entry point (`/`).
 *
 * Provides a coherent entry flow into the app: an authenticated customer is
 * routed straight to the Dashboard, and an unauthenticated visitor is routed to
 * the login entry point (Requirement 1.6, 11 end-to-end wiring). All credential
 * handling stays server-side — this server component reads the session via
 * `getServerSession` and never exposes the access token to the browser.
 */

import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { getAuthOptions } from '@/lib/server/auth';

// Reading the session must happen per-request, never at build time.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const session = await getServerSession(getAuthOptions());
  if (session) {
    redirect('/dashboard');
  }
  redirect('/login');
}
