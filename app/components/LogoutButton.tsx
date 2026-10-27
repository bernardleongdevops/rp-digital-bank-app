'use client';

/**
 * Logout control for the Banking_App (Requirement 1.5).
 *
 * Performs a FEDERATED logout so the user is fully signed out, not just locally:
 *   1. ask the server for the Keycloak end-session URL (which reads the
 *      server-only `id_token` to build an `id_token_hint`),
 *   2. clear the local NextAuth session cookie via `signOut` (no redirect), then
 *   3. navigate to Keycloak's end-session endpoint, which ends the SSO session
 *      and redirects back to `/login`.
 *
 * Without step 3, Keycloak keeps its own SSO session and the next "Sign in"
 * would silently re-authenticate without prompting for credentials.
 *
 * This is a reusable control for the authenticated views (dashboard, statement,
 * transfer); it is a client component so it can call `signOut` and navigate.
 */

import { signOut } from 'next-auth/react';
import { useState } from 'react';

export function LogoutButton({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);

  async function handleLogout() {
    setBusy(true);
    try {
      // 1. Resolve the Keycloak end-session URL (server reads the id_token).
      let keycloakLogoutUrl: string | null = null;
      try {
        const res = await fetch('/api/auth/federated-logout', {
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          const data = (await res.json()) as { url?: string };
          keycloakLogoutUrl = data.url ?? null;
        }
      } catch {
        // If the lookup fails, fall back to a local-only sign-out below.
      }

      // 2. Clear the local session WITHOUT letting NextAuth redirect, so we can
      //    then hand off to Keycloak ourselves.
      await signOut({ redirect: false });

      // 3. End the Keycloak SSO session (then it returns to /login). If we
      //    couldn't build the federated URL, just go to /login locally.
      window.location.href = keycloakLogoutUrl ?? '/login';
    } catch {
      setBusy(false);
      window.location.href = '/login';
    }
  }

  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={() => {
        void handleLogout();
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
