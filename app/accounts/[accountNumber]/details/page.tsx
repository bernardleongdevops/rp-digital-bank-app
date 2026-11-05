/**
 * `/accounts/[accountNumber]/details` page -- the Account_Details_View
 * (Requirement 2).
 *
 * This route is protected by `middleware.ts`, which redirects any
 * unauthenticated request to `/login` before this component renders
 * (Requirement 1.6 of v1), so the page itself assumes an authenticated
 * session.
 *
 * The page is a thin server component that reads the `accountNumber` route
 * segment and hands it to the `AccountDetailsClient` client component. All data
 * fetching happens in the browser against the same-origin BFF endpoint
 * (`GET /api/bff/accounts/[accountNumber]`), so the browser never talks to the
 * Sandbox_Gateway directly and never sees the access token or Sandbox_Key
 * (Requirement 2.1, 8.9, 9.x; design Property 9).
 */

import { AccountDetailsClient } from './AccountDetailsClient';

export const dynamic = 'force-dynamic';

interface AccountDetailsPageProps {
  params: { accountNumber: string };
}

export default function AccountDetailsPage({ params }: AccountDetailsPageProps) {
  const accountNumber = decodeURIComponent(params.accountNumber);
  return <AccountDetailsClient accountNumber={accountNumber} />;
}
