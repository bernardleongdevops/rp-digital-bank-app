/**
 * `/accounts/open` page — hosts the OpenAccountForm (task 6.1, Requirement 3).
 *
 * This route is protected by the middleware (an unauthenticated request is
 * redirected to `/login`), so the page itself assumes a signed-in customer. It
 * is a thin server component that provides page chrome (the shared `AppHeader`
 * with the accounts destination marked active, and a heading) and renders the
 * `OpenAccountForm` client component, which owns the field state, the full
 * client-side validation (Requirement 3.2), the submission to
 * `POST /api/bff/accounts`, and the outcome rendering (Requirements 3.3, 3.8,
 * 3.10, 3.11, 3.12).
 *
 * The page is `force-dynamic`: it is a protected, session-dependent view that
 * must never be statically optimized.
 */

import { AppHeader } from '@/app/components/AppHeader';
import { OpenAccountForm } from './OpenAccountForm';

// Protected, session-dependent view: never statically optimized.
export const dynamic = 'force-dynamic';

export default function OpenAccountPage() {
  return (
    <main>
      <AppHeader active="accounts" />
      <h1>Open an account</h1>
      <OpenAccountForm />
    </main>
  );
}
