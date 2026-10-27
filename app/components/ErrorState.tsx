'use client';

/**
 * Shared error state (Requirements 8.2, 8.3, 8.4, 8.6).
 *
 * Rendered when a Sandbox_Gateway request (via the BFF) fails -- a connectivity
 * problem, a timeout, or an upstream error status. It shows a safe,
 * human-readable message and a retry action that re-initiates the failed
 * request (Requirements 8.2, 8.3).
 *
 * Security: the caller supplies only a safe, user-facing message. This
 * component never renders raw upstream detail, stack traces, secrets, or the
 * Sandbox_Key / access token -- it has no server-only imports and treats
 * `message` as display copy only. Callers should pass a curated message (the
 * BFF forwards only `status` + `error` code), not raw upstream bodies.
 *
 * Accessibility: uses `role="alert"` so the error is announced immediately by
 * assistive technology. The retry control is a real `<button>` (keyboard
 * operable, focusable) with a meaningful label.
 */

export interface ErrorStateProps {
  /** Safe, user-facing message. Must not contain secrets or raw upstream detail. */
  message?: string;
  /** Re-initiates the failed request. When omitted, no retry control renders. */
  onRetry?: () => void;
  /** Label for the retry control. */
  retryLabel?: string;
  /**
   * When false, the retry control is disabled -- used for the rate-limited
   * (429) case where retry must wait for a short delay (Requirement 8.7).
   */
  canRetry?: boolean;
  className?: string;
}

export function ErrorState({
  message = 'Something went wrong. Please try again.',
  onRetry,
  retryLabel = 'Retry',
  canRetry = true,
  className,
}: ErrorStateProps) {
  return (
    <div className={className} role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} disabled={!canRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
