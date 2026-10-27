'use client';

/**
 * Shared loading state (Requirements 8.1, 8.6).
 *
 * A reusable, accessible indicator shown while a data-dependent view waits on a
 * Sandbox_Gateway request (via the BFF). Per Requirement 8.1 the view renders
 * this within 300 ms of initiating the request; this component is purely
 * presentational and carries no secrets or server-only imports.
 *
 * Accessibility: uses `role="status"` with `aria-live="polite"` so assistive
 * technology announces that content is loading. The visible label is meaningful
 * text (not a bare spinner), and an `aria-busy` hint is exposed on the region.
 */

export interface LoadingStateProps {
  /** Accessible, human-readable description of what is loading. */
  label?: string;
  className?: string;
}

export function LoadingState({ label = 'Loading…', className }: LoadingStateProps) {
  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {/* Decorative spinner; the adjacent text carries the meaning. */}
      <span aria-hidden="true" data-testid="loading-spinner" />
      <span>{label}</span>
    </div>
  );
}
