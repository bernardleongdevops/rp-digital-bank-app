'use client';

/**
 * Shared application navigation header (Requirements 8.1, 8.2, 8.3).
 *
 * A single, reusable navigation surface rendered on every authenticated
 * Banking_App view so navigation is consistent across the product. It provides
 * a link to each primary destination -- the Dashboard, the Transfer_Form, the
 * Profile_Page, the accounts area (Statement_View / Account_Details_View are
 * reached from there), Account_Management (open account), and the
 * Scheduled_Transfer views -- plus the existing shared `LogoutButton` as the
 * single logout control (Requirement 8.1).
 *
 * The logout control reuses `LogoutButton`, which performs the existing
 * federated logout flow: it clears the local session and redirects the customer
 * to the login entry point (Requirement 8.3). This component adds no logout
 * logic of its own.
 *
 * This is a purely presentational client component: it holds no secrets, makes
 * no network calls, and has no server-only imports. Internal navigation uses
 * `next/link` (consistent with `DashboardClient`) so transitions are
 * client-side.
 *
 * Accessibility: the links sit inside a semantic `<header>` with a single
 * `<nav aria-label="Primary">` landmark. Every destination is a real,
 * keyboard-reachable link. The `active` prop marks the current destination with
 * `aria-current="page"` so assistive technology announces which view is active.
 *
 * Note on wiring: this component is created here as a reusable unit only. It is
 * rendered into the individual pages in a later task (12.1); some destinations
 * (e.g. `/profile`, `/accounts/open`, `/scheduled-transfers`) point at routes
 * that are built in later tasks and may not exist yet.
 */

import Link from 'next/link';
import { LogoutButton } from '@/app/components/LogoutButton';

/** The primary destinations that can be marked active in the AppHeader. */
export type AppHeaderActive =
  | 'dashboard'
  | 'transfer'
  | 'profile'
  | 'accounts'
  | 'payees'
  | 'scheduled';

export interface AppHeaderProps {
  /** Marks the active destination for `aria-current` styling. */
  active?: AppHeaderActive;
  className?: string;
}

/** A single navigation destination descriptor. */
interface NavItem {
  /** The destination route. */
  href: string;
  /** The visible, human-readable label. */
  label: string;
  /** The `active` key this item corresponds to, when applicable. */
  key?: AppHeaderActive;
}

/**
 * The ordered list of primary navigation destinations (Requirement 8.1).
 *
 * The Statement_View and Account_Details_View are reached from the accounts
 * area (the Dashboard account list links to each account's statement, which in
 * turn links to its details), so they are represented here by the accounts
 * destination rather than a standalone link.
 */
const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { href: '/dashboard', label: 'Dashboard', key: 'dashboard' },
  { href: '/transfer', label: 'Transfer', key: 'transfer' },
  { href: '/scheduled-transfers', label: 'Scheduled transfers', key: 'scheduled' },
  { href: '/accounts/open', label: 'Open account', key: 'accounts' },
  { href: '/profile', label: 'Profile', key: 'profile' },
];

export function AppHeader({ active, className }: AppHeaderProps) {
  return (
    <header className={className}>
      <nav aria-label="Primary">
        <ul>
          {NAV_ITEMS.map((item) => {
            const isActive = item.key !== undefined && item.key === active;
            return (
              <li key={item.href}>
                <Link href={item.href} aria-current={isActive ? 'page' : undefined}>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <LogoutButton />
    </header>
  );
}
