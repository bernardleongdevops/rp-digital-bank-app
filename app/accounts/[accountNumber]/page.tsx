/**
 * `/accounts/[accountNumber]` page -- the Statement_View (Requirement 3).
 *
 * This route is protected by `middleware.ts`, which redirects any
 * unauthenticated request to `/login` before this component renders
 * (Requirement 1.6), so the page itself assumes an authenticated session.
 *
 * The page is a thin server component that reads the `accountNumber` route
 * segment and hands it to the `StatementClient` client component. All data
 * fetching happens in the browser against the same-origin BFF endpoints
 * (`/api/bff/accounts/[accountNumber]` and `.../transactions`), so the browser
 * never talks to the Sandbox_Gateway directly and never sees the access token
 * or Sandbox_Key (Requirement 6.2-6.4).
 */

import { StatementClient } from './StatementClient';

export const dynamic = 'force-dynamic';

interface StatementPageProps {
  params: { accountNumber: string };
}

export default function StatementPage({ params }: StatementPageProps) {
  const accountNumber = decodeURIComponent(params.accountNumber);
  return <StatementClient accountNumber={accountNumber} />;
}
