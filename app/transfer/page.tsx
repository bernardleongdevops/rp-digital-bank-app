/**
 * `/transfer` page — hosts the Transfer_Form (task 9.1, Requirement 5).
 *
 * This route is protected by the middleware (an unauthenticated request is
 * redirected to `/login`), so the page itself assumes a signed-in customer. It
 * is a thin server component that provides page chrome (heading, logout) and
 * renders the `TransferForm` client component, which owns the field state and
 * full client-side validation.
 *
 * It renders the shared `AppHeader` (navigation + single logout control,
 * Requirements 8.1, 8.2, 8.3) with the Transfer destination marked active.
 *
 * Submission and outcome rendering are task 9.2: this page mounts the
 * `TransferContainer` client component, which wires the form's `onValidSubmit`
 * + `submitting` seams, POSTs to `/api/bff/transfers`, enforces the in-flight
 * submit guard (Requirement 4.2), and renders the outcome-specific result
 * banner (Requirements 4.3-4.10).
 */

import { AppHeader } from '@/app/components/AppHeader';
import { TransferContainer } from './TransferContainer';

export default function TransferPage() {
  return (
    <main>
      {/* Shared navigation + single logout control (Requirements 8.1, 8.2,
          8.3), replacing the ad-hoc back-to-dashboard nav and the standalone
          LogoutButton. The Transfer destination is marked active. */}
      <AppHeader active="transfer" />
      <h1>Transfer money</h1>
      <TransferContainer />
    </main>
  );
}
