/**
 * `/scheduled-transfers` page — hosts the Scheduled_Transfer views (task 9.1,
 * Requirement 6).
 *
 * This route is protected by the middleware (an unauthenticated request is
 * redirected to `/login`), so the page itself assumes a signed-in customer. It
 * is a thin server component that provides page chrome (the shared `AppHeader`
 * with the scheduled destination marked active, and a heading) and renders the
 * `ScheduledTransfersClient` client component, which owns the create form, the
 * list, the cancel control, and the executed-outcome rendering.
 *
 * The page is `force-dynamic`: it is a protected, session-dependent view that
 * must never be statically optimized.
 */

import { AppHeader } from '@/app/components/AppHeader';
import { ScheduledTransfersClient } from './ScheduledTransfersClient';

// Protected, session-dependent view: never statically optimized.
export const dynamic = 'force-dynamic';

export default function ScheduledTransfersPage() {
  return (
    <main>
      <AppHeader active="scheduled" />
      <h1>Scheduled transfers</h1>
      <ScheduledTransfersClient />
    </main>
  );
}
