/**
 * `/profile` page -- the Profile_Page (Requirement 7).
 *
 * This route is protected by `middleware.ts`, which redirects any
 * unauthenticated request to `/login` before this component renders, so the
 * page itself assumes an authenticated session.
 *
 * The page is a thin server-component shell that renders the shared
 * `AppHeader` (with the Profile destination marked active, Requirements 8.1,
 * 8.2) and the `ProfileClient` client component. All banking data is fetched
 * client-side from the same-origin BFF read endpoint `GET /api/bff/customer`
 * (Requirement 7.1), so the browser only ever reaches the BFF and never the
 * Sandbox_Gateway directly -- the access token and Sandbox_Key stay
 * server-side inside the BFF (Requirement 8.9 / browser-to-BFF-only).
 */

import { AppHeader } from '@/app/components/AppHeader';
import { ProfileClient } from './ProfileClient';

// Protected, session-dependent view: never statically optimized.
export const dynamic = 'force-dynamic';

export default function ProfilePage() {
  return (
    <>
      <AppHeader active="profile" />
      <ProfileClient />
    </>
  );
}
