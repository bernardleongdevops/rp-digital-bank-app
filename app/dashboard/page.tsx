/**
 * `/dashboard` page (Requirement 2) -- the authenticated landing view listing
 * the signed-in customer's profile summary and their accounts, each linking to
 * its statement view at `/accounts/[accountNumber]`.
 *
 * This is a thin server component shell: route protection is enforced upstream
 * by `middleware.ts` (any request without a valid session is redirected to
 * `/login` before this renders, Requirement 1.6), so the page simply mounts the
 * `DashboardClient`. All banking data is fetched client-side from the
 * same-origin BFF read endpoints (`/api/bff/customer`, `/api/bff/accounts`) so
 * the browser only ever reaches the BFF and never the Sandbox_Gateway directly
 * (Requirement 6.4 / browser-to-BFF-only). Fetching client-side also lets each
 * data region manage its own loading / empty / error / retry state per the
 * design's "Client-side data fetching" section.
 */

import { DashboardClient } from './DashboardClient';

// Protected, session-dependent view: never statically optimized.
export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  return <DashboardClient />;
}
