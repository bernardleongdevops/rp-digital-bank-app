'use client';

/**
 * Shared empty state (Requirements 8.5, 8.6).
 *
 * Rendered when a Sandbox_Gateway request succeeds but returns no data for the
 * view -- e.g. a customer with no accounts, or a transaction date range that
 * contains zero entries. Purely presentational; no secrets, no server-only
 * imports.
 *
 * Accessibility: the region is a `<section>` labelled by its heading so the
 * empty message is discoverable. The message is meaningful text rather than an
 * icon alone.
 */

import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** Short, meaningful title, e.g. "No accounts". */
  title: string;
  /** Optional supporting detail explaining the empty result. */
  description?: string;
  /** Optional action (e.g. adjust filters) rendered beneath the message. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <section className={className} aria-label={title}>
      <p>
        <strong>{title}</strong>
      </p>
      {description ? <p>{description}</p> : null}
      {action ? <div>{action}</div> : null}
    </section>
  );
}
