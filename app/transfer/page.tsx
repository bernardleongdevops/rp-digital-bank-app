/**
 * `/transfer` page — hosts the Transfer_Form (task 9.1, Requirement 5).
 *
 * This route is protected by the middleware (an unauthenticated request is
 * redirected to `/login`), so the page itself assumes a signed-in customer. It
 * is a thin server component that provides page chrome (heading, logout) and
 * renders the `TransferForm` client component, which owns the field state and
 * full client-side validation.
 *
 * Submission and outcome rendering are task 9.2: this page mounts the
 * `TransferContainer` client component, which wires the form's `onValidSubmit`
 * + `submitting` seams, POSTs to `/api/bff/transfers`, enforces the in-flight
 * submit guard (Requirement 4.2), and renders the outcome-specific result
 * banner (Requirements 4.3-4.10).
 */

import Link from 'next/link';
import { LogoutButton } from '@/app/components/LogoutButton';
import { TransferContainer } from './TransferContainer';

export default function TransferPage() {
  return (
    <main>
      <header>
        <nav aria-label="Primary">
          <Link href="/dashboard">Back to dashboard</Link>
        </nav>
        <h1>Transfer money</h1>
        <LogoutButton />
      </header>
      <TransferContainer />
    </main>
  );
}
