/**
 * Federated logout helper.
 *
 * NextAuth's `signOut` clears only the LOCAL app session cookie. Keycloak keeps
 * its own SSO session, so a subsequent "Sign in" silently re-authenticates
 * without prompting. To fully sign the user out we must also end the Keycloak
 * session at its OIDC `end_session_endpoint`.
 *
 * This server route reads the `id_token` from the server-side JWT (never
 * exposed to the browser), builds the Keycloak logout URL with an
 * `id_token_hint` and a `post_logout_redirect_uri` back to `/login`, and
 * returns it as JSON. The `LogoutButton` calls this, then `signOut`, then
 * navigates to the returned URL. The issuer and app URL stay server-side.
 */

import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { cookies, headers } from 'next/headers';
import { getConfig } from '@/lib/server/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const config = getConfig();

  // Reconstruct a minimal request for getToken from the current cookies.
  const cookieStore = cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const req = {
    headers: {
      cookie: cookieHeader,
      ...Object.fromEntries(headers().entries()),
    },
    cookies: Object.fromEntries(cookieStore.getAll().map((c) => [c.name, c.value])),
  };

  const token = await getToken({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req: req as any,
    secret: config.nextAuthSecret,
  });

  const postLogoutRedirect = `${config.appUrl}/login`;
  const endSession = `${config.keycloakIssuer}/protocol/openid-connect/logout`;

  const params = new URLSearchParams();
  params.set('post_logout_redirect_uri', postLogoutRedirect);
  params.set('client_id', config.keycloakClientId);
  if (token?.idToken) {
    params.set('id_token_hint', token.idToken);
  }

  return NextResponse.json({ url: `${endSession}?${params.toString()}` });
}
